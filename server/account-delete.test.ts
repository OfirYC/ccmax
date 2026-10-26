import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import type { FastifyInstance,InjectOptions } from 'fastify';
import { createApp } from './app.js';
import { migrate,type DB } from './db.js';
import { bootstrap,id } from './core.js';
import { openTestDB } from './test-db.js';

describe('account deletion',()=>{
  let db:DB,app:FastifyInstance,cookie:string,ownerId:string,accountId:string,connectionId:string,agentId:string;
  const password='account-delete-password';
  async function call(method:string,url:string,payload?:any){return app.inject({method,url,headers:{cookie,'x-ccmax-request':'1'},payload} as InjectOptions);}
  beforeEach(async()=>{
    db=await openTestDB();await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:password});
    const [owner]=await db.query('SELECT * FROM users WHERE role=\'owner\'');ownerId=owner.id;
    agentId=id();await db.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$3,$4)',[agentId,ownerId,'agent@example.com',owner.password_hash]);
    accountId=id();await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,false)',[accountId,agentId,'pending@example.com']);
    connectionId=id();await db.query('INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,\'ai008\',$2,\'{}\',0.8)',[connectionId,'test connection']);
    ({app}=await createApp(db,{encryptionKey:'ab'.repeat(32),appUrl:'http://localhost:3000'}));
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:'agent@example.com',password}});expect(login.statusCode).toBe(200);cookie=String(login.headers['set-cookie']).split(';')[0];
  });
  afterEach(async()=>{await app.close();await db.close();});

  it('deletes only an unverified unbound account and removes terminal authorization attempts',async()=>{
    const attemptId=id();
    await db.query('INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,state,expires_at) VALUES($1,$2,$3,$4,\'encrypted\',\'\',\'done\',now()+interval \'1 hour\')',[attemptId,agentId,connectionId,accountId]);
    await db.query('INSERT INTO oauth_code_claims(user_id,code_hash,attempt_id) VALUES($1,\'hash\',$2)',[agentId,attemptId]);
    const response=await call('DELETE','/api/accounts/'+accountId);
    expect(response.statusCode,response.body).toBe(200);
    expect(await db.query('SELECT id FROM accounts WHERE id=$1',[accountId])).toHaveLength(0);
    expect(await db.query('SELECT id FROM oauth_attempts WHERE id=$1',[attemptId])).toHaveLength(0);
    expect(await db.query('SELECT attempt_id FROM oauth_code_claims WHERE attempt_id=$1',[attemptId])).toHaveLength(0);
    expect((await db.query("SELECT action FROM audits WHERE target_id=$1",[accountId])).map(row=>row.action)).toContain('account.delete');
  });

  it.each([
    ['verified ownership',async()=>{await db.query('UPDATE accounts SET ownership_verified=true WHERE id=$1',[accountId]);},'已核实归属的账号不能删除'],
    ['platform binding',async()=>{await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[id(),accountId,connectionId]);},'已有平台绑定的账号不能删除'],
    ['active authorization',async()=>{await db.query('INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,state,expires_at) VALUES($1,$2,$3,$4,\'encrypted\',\'\',\'pending\',now()+interval \'1 hour\')',[id(),agentId,connectionId,accountId]);},'账号授权流程正在进行'],
  ])('rejects deletion with %s',async(_label,setup,message)=>{
    await setup();
    const response=await call('DELETE','/api/accounts/'+accountId);
    expect(response.statusCode).toBe(409);expect(response.json().error).toContain(message);
    expect(await db.query('SELECT id FROM accounts WHERE id=$1',[accountId])).toHaveLength(1);
  });
});
