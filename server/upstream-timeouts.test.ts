import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewApiClient } from './new-api.js';
import { KeyManClient } from './keyman-newapi.js';

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

describe('upstream response timeouts',()=>{
  it.each([
    {name:'New API',timeout:15000,client:()=>new NewApiClient('https://new-api.test',{kind:'access_token',token:'fixture'})},
    {name:'KeyMan',timeout:20000,client:()=>new KeyManClient('https://keyman.test',{kind:'access_token',token:'fixture'})},
  ])('times out a stalled $name response body without replaying the request',async({timeout,client})=>{
    vi.useFakeTimers();
    let stream:ReadableStreamDefaultController<Uint8Array>;
    let signal:AbortSignal|undefined;
    const request=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
      signal=init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({start(controller){
        stream=controller;
        controller.enqueue(new TextEncoder().encode('{"data":'));
        signal!.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')),{once:true});
      }}),{headers:{'Content-Type':'application/json'}});
    });
    vi.stubGlobal('fetch',request);
    let outcome:unknown='pending';
    const operation=client().authenticate().then(()=>{outcome='succeeded';},error=>{outcome=error;});
    try {
      await vi.advanceTimersByTimeAsync(timeout+1);
      expect(outcome).toMatchObject({statusCode:502,message:expect.stringContaining('请求超时')});
      expect(signal?.aborted).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      stream!.error(new Error('fixture closed'));
      await operation;
    }
  });
});
