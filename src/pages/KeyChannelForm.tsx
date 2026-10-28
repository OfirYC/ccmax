import { useEffect, useState } from 'react';
import { api, key, post, type RecordData } from '../api';
import { ErrorBox, Field, Form, Modal, Submit, useToast } from '../components';

type ChannelType = { value: number; label: string; keyPrompt?: string; baseUrlPlaceholder?: string; baseUrlDefault?: string; baseUrlRequired?: boolean; otherLabel?: string; otherPlaceholder?: string; tip?: string; fetchable?: boolean };
type MappingRow = { from: string; to: string };

export const KEYMAN_CHANNEL_TYPES: ChannelType[] = [
  { value: 1, label: 'OpenAI', keyPrompt: 'sk-xxxx，OpenAI API Key', baseUrlPlaceholder: '可空，默认官方地址（末尾不要带 /v1 和 /）', fetchable: true },
  { value: 14, label: 'Anthropic Claude', keyPrompt: 'sk-ant-xxxx，Anthropic API Key', baseUrlPlaceholder: '可空，默认官方地址 https://api.anthropic.com', fetchable: true },
  { value: 33, label: 'AWS Bedrock', keyPrompt: 'AccessKey|SecretAccessKey|Region', fetchable: true },
  { value: 41, label: 'Google Vertex AI', keyPrompt: '服务账号 JSON，或 API Key', otherLabel: '部署地区', otherPlaceholder: '例如 us-central1，或按模型填写 JSON 映射', tip: 'JSON 模式支持完整服务账号 JSON；API Key 模式适合 Gemini API Key。', fetchable: true },
  { value: 3, label: 'Azure OpenAI', baseUrlPlaceholder: '请填写 Azure 端点，例如 https://example.openai.azure.com', baseUrlRequired: true, otherLabel: '默认 API 版本', otherPlaceholder: '例如 2025-04-01-preview' },
  { value: 4, label: 'Ollama', keyPrompt: '未设置鉴权可随意填写（如 ollama）', baseUrlPlaceholder: 'Ollama 部署地址，例如 http://localhost:11434', fetchable: true },
  { value: 8, label: '自定义渠道', baseUrlPlaceholder: '请填写完整调用地址，例如 https://api.example.com/v1/chat/completions', baseUrlRequired: true },
  { value: 15, label: '百度文心千帆', keyPrompt: 'APIKey|SecretKey', fetchable: true },
  { value: 16, label: '智谱 ChatGLM' },
  { value: 17, label: '阿里通义千问', fetchable: true },
  { value: 18, label: '讯飞星火', keyPrompt: 'APPID|APISecret|APIKey' },
  { value: 20, label: 'OpenRouter', baseUrlPlaceholder: '可空，默认 https://openrouter.ai/api', fetchable: true },
  { value: 23, label: '腾讯混元', keyPrompt: 'AppId|SecretId|SecretKey', fetchable: true },
  { value: 24, label: 'Google Gemini', fetchable: true },
  { value: 25, label: 'Moonshot 月之暗面', fetchable: true },
  { value: 26, label: '智谱 GLM-4', fetchable: true },
  { value: 27, label: 'Perplexity', fetchable: true },
  { value: 31, label: '零一万物', fetchable: true },
  { value: 34, label: 'Cohere', fetchable: true },
  { value: 35, label: 'MiniMax', fetchable: true },
  { value: 37, label: 'Dify', baseUrlPlaceholder: '自部署填 Dify 服务地址，官方云可留空', fetchable: true },
  { value: 40, label: 'SiliconFlow 硅基流动', fetchable: true },
  { value: 42, label: 'Mistral AI', fetchable: true },
  { value: 43, label: 'DeepSeek', fetchable: true },
  { value: 45, label: '字节火山引擎（豆包）', keyPrompt: 'API Key；语音模型按 AppId|AccessToken 输入', baseUrlPlaceholder: '必填，默认 https://ark.cn-beijing.volces.com', baseUrlDefault: 'https://ark.cn-beijing.volces.com', baseUrlRequired: true },
  { value: 46, label: '百度千帆 V2', keyPrompt: 'bce-v3/xxx 格式 API Key' },
  { value: 47, label: 'Xinference', keyPrompt: '未设置鉴权可随意填写', baseUrlPlaceholder: '例如 http://localhost:9997', fetchable: true },
  { value: 48, label: 'xAI Grok', fetchable: true },
  { value: 49, label: 'Coze', keyPrompt: '个人访问令牌 pat_xxx 或 OAuth JWT 配置 JSON' },
  { value: 56, label: 'Replicate' },
  { value: 60, label: 'NewAPI 下游', keyPrompt: '下游 New-API 生成的令牌（sk-xxx）', baseUrlPlaceholder: '下游 New-API 地址，例如 https://your-newapi.com', baseUrlRequired: true },
];

const PRESET_MODELS: Record<number, string[]> = {
  1: ['gpt-5.5', 'gpt-5-2025-08-07', 'gpt-4o', 'gpt-4o-mini', 'o3'],
  3: ['gpt-5.5', 'gpt-4o', 'gpt-4o-mini'],
  14: ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5'],
  20: ['openai/gpt-5.5', 'anthropic/claude-fable-5', 'google/gemini-3.0-pro', 'deepseek/deepseek-chat'],
  24: ['gemini-3.0-pro', 'gemini-3.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  33: ['claude-opus-5-5', 'claude-sonnet-5'],
  40: ['deepseek-ai/DeepSeek-V3.1', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-235B-A22B'],
  41: ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-3.5-flash'],
  42: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
  43: ['deepseek-chat', 'deepseek-reasoner'],
  45: ['doubao-seed-1-6-250615', 'doubao-seed-1-6-thinking-250615', 'deepseek-v3-250324'],
  48: ['grok-4', 'grok-4-mini'],
};

function unique(values: string[]) { return [...new Set(values.map(value => value.trim()).filter(Boolean))]; }
function splitLines(value: string) { return unique(value.split(/[,，\n]/)); }
function typeForTask(task: RecordData) {
  const source = `${task.provider || ''} ${task.resource_type || ''} ${task.name || ''}`.toLowerCase();
  if (source.includes('vertex')) return 41;
  if (source.includes('anthropic') || source.includes('claude')) return 14;
  if (source.includes('azure')) return 3;
  if (source.includes('gemini') || source.includes('google')) return 24;
  return 1;
}
function parseJson(value: string) { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }

function TagPicker({ label, tags, setTags, input, setInput, options, placeholder, hint }: { label: string; tags: string[]; setTags: (values: string[]) => void; input: string; setInput: (value: string) => void; options?: string[]; placeholder: string; hint?: string }) {
  const add = (value: string) => { const next = splitLines(value); if (next.length) setTags(unique([...tags, ...next])); setInput(''); };
  return <div className="field tag-picker-field"><span>{label}</span><div className="tag-picker"><div className="tag-list">{tags.map(tag => <span className="input-tag" key={tag}>{tag}<button type="button" aria-label={`移除${tag}`} onClick={() => setTags(tags.filter(value => value !== tag))}>×</button></span>)}</div><input value={input} placeholder={placeholder} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ',' || event.key === '，') { event.preventDefault(); add(input); } }} onBlur={() => input.trim() && add(input)} /></div>{options && options.length > 0 && <div className="tag-options">{options.map(option => <button type="button" className={tags.includes(option) ? 'selected' : ''} key={option} onClick={() => setTags(tags.includes(option) ? tags.filter(value => value !== option) : [...tags, option])}>{option}</button>)}</div>}{hint && <small>{hint}</small>}</div>;
}

export function SubmitKeyModal({ task, onClose, onDone }: { task: RecordData; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const keyman = task.template_type === 'keyman_newapi';
  const [channelType, setChannelType] = useState(typeForTask(task));
  const [name, setName] = useState(`${task.name} · 我的渠道`);
  const [secretText, setSecretText] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [models, setModels] = useState(() => unique(task.models || []));
  const [groups, setGroups] = useState<string[]>(['default']);
  const [groupInput, setGroupInput] = useState('');
  const [availableGroups, setAvailableGroups] = useState<string[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState('');
  const [groupsAttempt, setGroupsAttempt] = useState(0);
  const [organization, setOrganization] = useState('');
  const [baseUrl, setBaseUrl] = useState(() => KEYMAN_CHANNEL_TYPES.find(item => item.value === typeForTask(task))?.baseUrlDefault || '');
  const [other, setOther] = useState('');
  const [testModel, setTestModel] = useState('');
  const [remark, setRemark] = useState('');
  const [proxyLevel, setProxyLevel] = useState<'low' | 'medium' | 'high'>('medium');
  const [autoBan, setAutoBan] = useState(true);
  const [settings, setSettings] = useState('');
  const [setting, setSetting] = useState('');
  const [paramOverride, setParamOverride] = useState('');
  const [statusCodeMapping, setStatusCodeMapping] = useState('');
  const [otherSettings, setOtherSettings] = useState('');
  const [keyFormat, setKeyFormat] = useState('json');
  const [mapping, setMapping] = useState<MappingRow[]>([{ from: '', to: '' }]);
  const meta = KEYMAN_CHANNEL_TYPES.find(item => item.value === channelType) || KEYMAN_CHANNEL_TYPES[0];
  const presets = PRESET_MODELS[channelType] || PRESET_MODELS[1];

  useEffect(() => {
    if (channelType === 41) {
      const current = parseJson(settings); current.vertex_key_type = keyFormat; setSettings(JSON.stringify(current));
    }
  }, [channelType, keyFormat]);
  useEffect(() => {
    if (!keyman) return;
    let active = true; setGroupsLoading(true); setGroupsError('');
    void api<{ groups: string[] }>(`/api/key-tasks/${task.id}/options`).then(result => {
      if (!active) return;
      setAvailableGroups(unique(result.groups || []));
    }).catch(error => { if (active) setGroupsError((error as Error).message); }).finally(() => { if (active) setGroupsLoading(false); });
    return () => { active = false; };
  }, [keyman, task.id, groupsAttempt]);

  function addModels(value: string) { const next = splitLines(value); if (!next.length) return; setModels(unique([...models, ...next])); setModelInput(''); }
  function updateSetting(keyName: string, value: string) { const current = parseJson(settings); if (value) current[keyName] = value; else delete current[keyName]; setSettings(JSON.stringify(current)); }
  async function fetchModels() {
    try {
      const first = secretText.split(/\n/).map(value => value.trim()).find(Boolean);
      if (!first) throw new Error('请先填写一个密钥');
      const result = await post<{ models: string[] }>(`/api/key-tasks/${task.id}/models`, { secret: first, channelType, baseUrl });
      setModels(unique(result.models || [])); toast(`已从上游拉取 ${result.models?.length || 0} 个模型`);
    } catch (error) { toast((error as Error).message, 'error'); }
  }
  function mappingObject() { return mapping.reduce<Record<string, string>>((result, row) => { if (row.from.trim() && row.to.trim()) result[row.from.trim()] = row.to.trim(); return result; }, {}); }
  function submitStandard(f: FormData) {
    const secret = String(f.get('secret') || '').trim();
    if (!secret) throw new Error('请填写上游 API Key');
    return post(`/api/key-tasks/${task.id}/channels`, { secret, name: String(f.get('name') || ''), site: '', models: models.length ? models : task.models || [], idempotencyKey: key() });
  }
  return <Modal title={keyman ? '提交 KeyMan 渠道' : '提交上游 Key'} subtitle={`${task.name} · 密钥仅服务端加密保存，前端始终显示掩码`} wide onClose={onClose}>
    <Form onSubmit={async form => {
      if (!keyman) { await submitStandard(form); toast('Key 已加密保存并创建渠道'); await onDone(); return; }
      const secrets = secretText.split(/\n/).map(value => value.trim()).filter(Boolean);
      if (!secrets.length) throw new Error('请至少填写一个 API Key');
      if (!models.length) throw new Error('请至少选择一个模型');
      if (meta.baseUrlRequired && !baseUrl.trim()) throw new Error(`${meta.label}必须填写 API 地址`);
      let parsedSettings: unknown = settings; if (settings.trim()) parsedSettings = parseJson(settings);
      if (settings.trim() && Object.keys(parseJson(settings)).length === 0) throw new Error('类型专属设置必须是合法 JSON');
      if (setting.trim() && Object.keys(parseJson(setting)).length === 0) throw new Error('渠道额外设置必须是合法 JSON');
      if (paramOverride.trim() && Object.keys(parseJson(paramOverride)).length === 0) throw new Error('参数覆盖必须是合法 JSON');
      if (statusCodeMapping.trim() && Object.keys(parseJson(statusCodeMapping)).length === 0) throw new Error('状态码复写必须是合法 JSON');
      const payload = { name, site: '', secrets, channelType, baseUrl, models, groups: groups.length ? groups : ['default'], modelMapping: mappingObject(), openaiOrganization: organization, testModel, remark, socks5ProxyLevel: proxyLevel, autoBan, settings: parsedSettings, setting, paramOverride, other: other || otherSettings, statusCodeMapping, idempotencyKey: key() };
      await post(`/api/key-tasks/${task.id}/channels`, payload);
      toast(secrets.length > 1 ? `已提交 ${secrets.length} 个渠道` : 'Key 已加密保存并创建渠道'); await onDone();
    }}>
      {keyman ? <>
      <div className="form-grid"><Field label="类型"><select name="channelType" value={channelType} onChange={event => { const next = Number(event.target.value); setChannelType(next); if (!baseUrl || baseUrl === meta.baseUrlDefault) setBaseUrl(KEYMAN_CHANNEL_TYPES.find(item => item.value === next)?.baseUrlDefault || ''); setSettings(current => { const parsed = parseJson(current); if (next === 41) parsed.vertex_key_type = keyFormat; else delete parsed.vertex_key_type; return Object.keys(parsed).length ? JSON.stringify(parsed) : ''; }); }}>{KEYMAN_CHANNEL_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field><Field label="渠道名称"><input name="name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="请输入渠道名称" /></Field></div>
      <Field label="密钥（批量添加，每行一个）" hint="每个 Key 会在 KeyMan 中创建独立渠道，指纹用于防止重复提交。Vertex 服务账号 JSON 可完整粘贴。"><textarea name="secrets" required rows={6} value={secretText} onChange={event => setSecretText(event.target.value)} placeholder={meta.keyPrompt || '请输入渠道对应的鉴权密钥'} /></Field>
      <div className="form-grid"><Field label="组织"><input name="openaiOrganization" value={organization} onChange={event => setOrganization(event.target.value)} placeholder="可选，默认组织" /></Field><Field label={meta.baseUrlRequired ? 'API 地址（必填）' : 'API 地址'} hint="部分官方渠道可留空，网关会使用默认地址"><input name="baseUrl" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={meta.baseUrlPlaceholder || '可选，例如 https://api.example.com/v1'} /></Field></div>
      {channelType === 41 && <Field label="Vertex 密钥格式" hint="服务账号 JSON 支持完整文件内容；API Key 模式不支持批量服务账号"><select value={keyFormat} onChange={event => setKeyFormat(event.target.value)}><option value="json">服务账号 JSON</option><option value="api_key">API Key</option></select></Field>}
      {meta.otherLabel && <Field label={meta.otherLabel} hint={meta.tip}><input name="other" value={other} onChange={event => setOther(event.target.value)} placeholder={meta.otherPlaceholder} /></Field>}
      {!meta.otherLabel && meta.tip && <div className="form-hint">{meta.tip}</div>}
      <div className="field tag-picker-field"><span>模型（选择或输入，回车添加）</span><div className="tag-picker"><div className="tag-list">{models.map(model => <span className="input-tag" key={model}>{model}<button type="button" aria-label={`移除${model}`} onClick={() => setModels(models.filter(value => value !== model))}>×</button></span>)}</div><input value={modelInput} onChange={event => setModelInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ',' || event.key === '，') { event.preventDefault(); addModels(modelInput); } }} onBlur={() => modelInput.trim() && addModels(modelInput)} placeholder="选择或输入模型，回车添加" /></div><div className="form-actions"><button type="button" className="text-button" onClick={() => setModels(unique([...models, ...presets]))}>填入该类型常用模型</button><button type="button" className="text-button" onClick={() => setModels([])}>清除所有模型</button>{meta.fetchable && <button type="button" className="text-button" onClick={() => void fetchModels()}>从上游拉取模型</button>}</div><small>当前已选 {models.length} 个模型。也可以在下方输入自定义模型名称。</small></div>
      <Field label="自定义模型"><div className="custom-model-row"><input value={modelInput} onChange={event => setModelInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addModels(modelInput); } }} placeholder="输入自定义模型名称，多个用逗号分隔" /><button type="button" className="button" onClick={() => addModels(modelInput)}>填入</button></div></Field>
      {keyman && <TagPicker label="分组" tags={groups} setTags={setGroups} input={groupInput} setInput={setGroupInput} options={availableGroups} placeholder={groupsLoading ? '正在读取平台分组…' : '选择或输入分组，回车添加'} hint={groupsError ? '平台分组读取失败，可重试；也可以继续使用 default 或自定义分组。' : '分组来自任务绑定的 KeyMan 网关，点击选项即可切换。'} />}
      {groupsError && <div className="inline-retry"><ErrorBox error={groupsError} /><button type="button" className="button" onClick={() => setGroupsAttempt(value => value + 1)} disabled={groupsLoading}>重新读取分组</button></div>}
      <div className="field mapping-field"><span>模型重定向</span><small>将请求模型映射到上游部署名；不需要时留空。</small>{mapping.map((row, index) => <div className="mapping-row" key={index}><input value={row.from} onChange={event => setMapping(mapping.map((item, i) => i === index ? { ...item, from: event.target.value } : item))} placeholder="原模型，例如 gpt-4" /><span>→</span><input value={row.to} onChange={event => setMapping(mapping.map((item, i) => i === index ? { ...item, to: event.target.value } : item))} placeholder="目标模型或部署名" /><button type="button" className="icon-button" aria-label="删除映射" onClick={() => setMapping(mapping.length === 1 ? [{ from: '', to: '' }] : mapping.filter((_, i) => i !== index))}>×</button></div>)}<button type="button" className="text-button" onClick={() => setMapping([...mapping, { from: '', to: '' }])}>添加一行</button></div>
      <details className="advanced-panel"><summary>高级设置（代理 / 测试模型 / 备注 / 参数覆盖等，透传网关）</summary><div className="form-grid"><Field label="Socks5 代理等级"><select name="socks5ProxyLevel" value={proxyLevel} onChange={event => setProxyLevel(event.target.value as 'low' | 'medium' | 'high')}><option value="low">低</option><option value="medium">中杯</option><option value="high">大杯</option></select></Field><Field label="测试模型"><input name="testModel" value={testModel} onChange={event => setTestModel(event.target.value)} placeholder="可选，留空使用第一个模型" /></Field><Field label="备注"><input name="remark" value={remark} onChange={event => setRemark(event.target.value)} placeholder="可选" /></Field></div><label className="checkbox-field"><input type="checkbox" checked={autoBan} onChange={event => setAutoBan(event.target.checked)} />失败达到阈值时自动封禁渠道</label><Field label="参数覆盖"><textarea name="paramOverride" value={paramOverride} onChange={event => setParamOverride(event.target.value)} rows={2} placeholder="JSON，可空" /></Field><Field label="渠道额外设置"><textarea name="setting" value={setting} onChange={event => setSetting(event.target.value)} rows={3} placeholder="JSON，可空；代理和网关参数会透传" /></Field><Field label="类型专属设置"><textarea name="settings" value={settings} onChange={event => setSettings(event.target.value)} rows={3} placeholder="JSON，可空；Vertex 可见 vertex_key_type 等设置" /></Field><Field label="状态码复写"><textarea name="statusCodeMapping" value={statusCodeMapping} onChange={event => setStatusCodeMapping(event.target.value)} rows={2} placeholder="JSON，可空，例如 {&quot;401&quot;:403}" /></Field><Field label="其他配置"><textarea name="otherSettings" value={otherSettings} onChange={event => setOtherSettings(event.target.value)} rows={2} placeholder="可空" /></Field></details>
      </> : <><Field label="上游 API Key" hint="提交后无法在前端查看完整 Key；同一任务不可重复提交。"><input name="secret" required minLength={8} maxLength={20000} type="password" autoComplete="off" placeholder="请输入上游 API Key" /></Field><Field label="渠道名称"><input name="name" required maxLength={120} defaultValue={`${task.name} · 我的 Key`} placeholder="请输入渠道名称" /></Field><Field label="模型覆盖（可选）"><input value={models.join(', ')} readOnly placeholder={(task.models || []).join(', ')} /></Field></>}
      <div className="modal-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><Submit>Confirm</Submit></div>
    </Form>
  </Modal>;
}
