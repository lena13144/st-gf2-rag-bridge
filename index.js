import {
    extension_prompt_types,
    extension_prompt_roles,
    saveSettingsDebounced,
    setExtensionPrompt,
    eventSource,
    event_types,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';

const MODULE_NAME = 'gf2_rag_bridge';
const PROMPT_TAG = 'gf2_rag_context';

const defaultSettings = {
    enabled: true,
    ragServer: 'http://127.0.0.1:5240',
    augment: false,
    useRerank: true,
    topK: 3,
    minScore: 0.35,
    depth: 1,
    chatBase: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
    chatKey: '',
    chatModel: 'deepseek-v4.1-flash-1017',
    embedBase: 'https://api.siliconflow.cn/v1',
    embedKey: '',
    embedModel: 'Qwen/Qwen3-Embedding-8B',
    rerankModel: 'Qwen/Qwen3-Reranker-8B',
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaultSettings };
    } else {
        for (const [k, v] of Object.entries(defaultSettings)) {
            if (extension_settings[MODULE_NAME][k] === undefined) {
                extension_settings[MODULE_NAME][k] = v;
            }
        }
    }
    return extension_settings[MODULE_NAME];
}

function cleanMessage(mes) {
    if (!mes) return '';
    return String(mes)
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/```html[\s\S]*?```/gi, '')
        .replace(/<[^>]+>/g, '')
        .trim();
}

function buildApiConfig(cfg) {
    const out = {};
    if (cfg.chatBase) out.chatBase = cfg.chatBase.trim();
    if (cfg.chatKey) out.chatKey = cfg.chatKey.trim();
    if (cfg.chatModel) out.chatModel = cfg.chatModel.trim();
    if (cfg.embedBase) out.embedBase = cfg.embedBase.trim();
    if (cfg.embedKey) out.embedKey = cfg.embedKey.trim();
    if (cfg.embedModel) out.embedModel = cfg.embedModel.trim();
    if (cfg.rerankModel) out.rerankModel = cfg.rerankModel.trim();
    return out;
}

// 数据库/世界书本轮选取完成后（WORLDINFO_ENTRIES_LOADED）再跑检索——
// context 吃本轮选中的全部条目（含数据库纪要），驱动"前世记忆"召回
function collectActivatedEntries(loreData) {
    const texts = [];
    const push = (x) => {
        if (!x) return;
        if (typeof x === 'string' && x.trim()) texts.push(x);
        else if (x.content && typeof x.content === 'string') texts.push(x.content);
    };
    const walk = (obj) => {
        if (!obj) return;
        if (Array.isArray(obj)) { obj.forEach(push); return; }
        if (obj instanceof Set || obj instanceof Map) { walk([...obj]); return; }
        if (typeof obj === 'object') {
            if (Array.isArray(obj.entries)) obj.entries.forEach(walk);
            else if (obj.entries instanceof Set || obj.entries instanceof Map) walk([...obj.entries]);
            if (Array.isArray(obj.allActivatedEntries)) obj.allActivatedEntries.forEach(walk);
            else if (obj.allActivatedEntries instanceof Set) walk([...obj.allActivatedEntries]);
        }
    };
    for (const key of ['globalLore', 'characterLore', 'charLore', 'chatLore', 'personaLore', 'entries']) walk(loreData?.[key]);
    if (!texts.length) walk(loreData);
    return texts;
}

async function genKeywordsViaDbPreset(cfg, query, context) {
    const shujuku = extension_settings?.shujuku_v120__userscript_settings_v1 || extension_settings?.shujuku_v104__userscript_settings_v1;
    let dbApi = null;
    for (const [k, v] of Object.entries(shujuku || {})) {
        if (k.endsWith('_settings') && typeof v === 'string') { try { dbApi = JSON.parse(v)?.apiConfig || dbApi; } catch (e) {} }
    }
    const base = (dbApi?.url || cfg.chatBase || '').replace(/\/+$/, '');
    const key = dbApi?.apiKey || cfg.chatKey || '';
    const model = dbApi?.model || cfg.chatModel || 'deepseek-v4.1-flash-1017';
    if (!base || !key) return { skip: true, kws: [] };
    const msgs = [
        { role: 'system', content: '你是交火关键词生成助手。根据用户输入与剧情纪要，输出最相关的简洁关键词或短语用于检索召回，关键词只能放在 <keywords> 标签内，用中文逗号分隔；若纯属日常闲聊无需检索则输出 NONE。' },
        { role: 'user', content: (context ? context + '\n\n' : '') + '当前用户输入：\n' + query + '\n\n请输出 <keywords>。' },
    ];
    const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model, messages: msgs, temperature: 0.1, max_tokens: 450 }),
    });
    if (!resp.ok) return { skip: false, kws: [] };
    const text = (await resp.json())?.choices?.[0]?.message?.content || '';
    const km = text.match(/<keywords>([\s\S]*?)<\/keywords>/i) || text.match(/关键词[：:]([\s\S]+)$/);
    if (!km) return { skip: false, kws: [] };
    const raw = km[1].trim();
    if (/^none$/i.test(raw)) return { skip: true, kws: [] };
    return { skip: false, kws: raw.split(/[，,、]/).map(x => x.trim()).filter(Boolean) };
}

let gf2RagRunning = false;
async function runRagRetrieval(loreData) {
    const cfg = getSettings();
    if (!cfg.enabled || gf2RagRunning) return;
    gf2RagRunning = true;
    const clear = () => setExtensionPrompt(PROMPT_TAG, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    try {
        const ctx = getContext();
        const chat = ctx?.chat || [];
        const lastUserMsg = chat.filter(m => m.is_user && m.mes).slice(-1)[0];
        const query = lastUserMsg ? cleanMessage(lastUserMsg.mes).slice(0, 500) : '';
        if (!query) { clear(); return; }

        const entryTexts = collectActivatedEntries(loreData);
        const context = entryTexts.length
            ? '【本轮世界书/纪要注入】\n' + entryTexts.join('\n').replace(/<[^>]+>/g, '')
            : '';

        let kws = [];
        if (cfg.augment) {
            try {
                const gk = await genKeywordsViaDbPreset(cfg, query, context);
                if (gk.skip) { console.debug('[GF2-RAG] gatekeeper: NONE'); clear(); return; }
                kws = gk.kws;
            } catch (e) { console.warn('[GF2-RAG] keyword gen failed, fallback to raw query', e); }
        }

        const server = (cfg.ragServer || 'http://127.0.0.1:5240').replace(/\/+$/, '');
        const resp = await fetch(`${server}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query, context, keywords: kws,
                augment: false,
                useRerank: cfg.useRerank,
                k: cfg.topK,
                apiConfig: buildApiConfig(cfg),
            }),
        });
        if (!resp.ok) return;
        const data = await resp.json();

        if (data.rerank === 'skipped_by_gatekeeper' || !Array.isArray(data.results) || !data.results.length) {
            clear(); return;
        }
        const hits = data.results.filter(r => r.score >= cfg.minScore);
        if (!hits.length) { clear(); return; }

        const block = hits.map((h, i) => `【原文片段 ${i + 1} | ${h.tag || h.group}】\n${h.text}`).join('\n\n');
        const promptText = `<gf2_source_reference>\n以下是检索到的《少女前线2：追放》原作台词与设定片段（{{user}}的潜在记忆素材），请作为既视感/闪回自然融入扮演，不要照搬旁白或复读：\n\n${block}\n</gf2_source_reference>`;
        console.log(`[GF2-RAG] Injected ${hits.length} chunks (${data.took_ms}ms) kws:`, data.keywords);
        setExtensionPrompt(PROMPT_TAG, promptText, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    } catch (err) {
        console.warn('[GF2-RAG] retrieval failed:', err);
    } finally {
        gf2RagRunning = false;
    }
}

eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, async (loreData) => {
    try { await runRagRetrieval(loreData); }
    catch (e) { console.warn('[GF2-RAG]', e); }
});

jQuery(async () => {
    const cfg = getSettings();
    const server = (cfg.ragServer || 'http://127.0.0.1:5240').replace(/\/+$/, '');

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'gf2rag',
        returns: 'GF2 RAG 检索开关状态',
        callback: (_args, value) => {
            const v = String(value || '').trim().toLowerCase();
            if (v === 'on' || v === '1' || v === 'true') cfg.enabled = true;
            else if (v === 'off' || v === '0' || v === 'false') cfg.enabled = false;
            else cfg.enabled = !cfg.enabled;
            saveSettingsDebounced();
            const el = $('#gf2_rag_enabled');
            if (el.length) el.prop('checked', cfg.enabled);
            toastr.info(`GF2 原文检索：${cfg.enabled ? '已开启' : '已关闭'}`);
            return cfg.enabled ? 'on' : 'off';
        },
        helpString: 'GF2 原文检索桥开关：/gf2rag on|off（不带参数则切换）',
    }));

    try {
        const r = await fetch(`${server}/config`);
        if (r.ok) {
            const srvCfg = await r.json();
            if (!cfg.chatKey && srvCfg.chatKey) cfg.chatKey = srvCfg.chatKey;
            if (!cfg.embedKey && srvCfg.embedKey) cfg.embedKey = srvCfg.embedKey;
            if (srvCfg.chatBase) cfg.chatBase = srvCfg.chatBase;
            if (srvCfg.chatModel) cfg.chatModel = srvCfg.chatModel;
            if (srvCfg.embedBase) cfg.embedBase = srvCfg.embedBase;
            if (srvCfg.embedModel) cfg.embedModel = srvCfg.embedModel;
            if (srvCfg.rerankModel) cfg.rerankModel = srvCfg.rerankModel;
        }
    } catch (_) {}

    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>GF2 原文检索桥 (RAG :5240)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display:flex;flex-direction:column;gap:8px;padding:8px 4px;">
            <label class="checkbox_label">
                <input id="gf2_rag_enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''} />
                <span><b>启用生成前自动检索注入</b></span>
            </label>
            <label class="checkbox_label" title="开启后每轮先调小模型读28章目录生成关键词（每次耗约2k tokens）；关闭则直接用Rerank分数过滤（0 LLM token消耗）">
                <input id="gf2_rag_augment" type="checkbox" ${cfg.augment ? 'checked' : ''} />
                <span>启用小模型守门员扩写 (耗 LLM Token；关闭则零LLM消耗直查)</span>
            </label>
            <label class="checkbox_label">
                <input id="gf2_rag_rerank" type="checkbox" ${cfg.useRerank ? 'checked' : ''} />
                <span>启用 Reranker 重排序</span>
            </label>

            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                <div>
                    <small>本地 RAG 服务地址：</small>
                    <input id="gf2_rag_server" class="text_pole" type="text" value="${cfg.ragServer}" style="width:190px;display:inline-block;" />
                </div>
                <div>
                    <small>Top-K：</small>
                    <input id="gf2_rag_topk" class="text_pole" type="number" min="1" max="8" value="${cfg.topK}" style="width:55px;display:inline-block;" />
                </div>
                <div>
                    <small>最低分阈值：</small>
                    <input id="gf2_rag_minscore" class="text_pole" type="number" step="0.05" min="0" max="1" value="${cfg.minScore}" style="width:65px;display:inline-block;" />
                </div>
            </div>

            <hr style="margin:4px 0;opacity:0.3;" />
            <div style="font-weight:bold;font-size:0.9em;">① 守门员/关键词小模型配置 (仅开启守门员时调用)</div>
            <div>
                <small>API Base URL (OpenAI 兼容)：</small>
                <input id="gf2_rag_chat_base" class="text_pole" type="text" value="${cfg.chatBase}" placeholder="https://api.xxx.com/v1" />
            </div>
            <div>
                <small>API Key：</small>
                <input id="gf2_rag_chat_key" class="text_pole" type="password" value="${cfg.chatKey}" placeholder="sk-..." />
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
                <div style="flex:1;">
                    <small>模型名称：</small>
                    <input id="gf2_rag_chat_model" class="text_pole" type="text" value="${cfg.chatModel}" list="gf2_rag_chat_model_list" />
                    <datalist id="gf2_rag_chat_model_list"></datalist>
                </div>
                <button id="gf2_rag_fetch_models" class="menu_button" style="width:auto;margin-top:16px;padding:4px 8px;">拉取模型列表</button>
            </div>

            <hr style="margin:4px 0;opacity:0.3;" />
            <div style="font-weight:bold;font-size:0.9em;">② Embedding & Rerank 配置 (SiliconFlow 等)</div>
            <div>
                <small>向量/重排 Base URL：</small>
                <input id="gf2_rag_embed_base" class="text_pole" type="text" value="${cfg.embedBase}" placeholder="https://api.siliconflow.cn/v1" />
            </div>
            <div>
                <small>向量/重排 API Key：</small>
                <input id="gf2_rag_embed_key" class="text_pole" type="password" value="${cfg.embedKey}" placeholder="sk-..." />
            </div>
            <div style="display:flex;gap:6px;">
                <div style="flex:1;">
                    <small>Embedding 模型 (需4096维兼容)：</small>
                    <input id="gf2_rag_embed_model" class="text_pole" type="text" value="${cfg.embedModel}" />
                </div>
                <div style="flex:1;">
                    <small>Rerank 模型：</small>
                    <input id="gf2_rag_rerank_model" class="text_pole" type="text" value="${cfg.rerankModel}" />
                </div>
            </div>

            <div style="display:flex;gap:8px;margin-top:4px;">
                <button id="gf2_rag_save_srv" class="menu_button" style="flex:1;">保存配置到 :5240 服务端</button>
                <button id="gf2_rag_test_btn" class="menu_button" style="flex:1;">测试检索</button>
            </div>
            <div id="gf2_rag_status" style="font-size:0.82em;color:#aaa;white-space:pre-wrap;max-height:160px;overflow:auto;"></div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    const bind = (sel, key, fn) => {
        $(sel).on('change input', function () {
            cfg[key] = fn ? fn($(this)) : $(this).val();
            saveSettingsDebounced();
        });
    };
    bind('#gf2_rag_enabled', 'enabled', el => el.prop('checked'));
    bind('#gf2_rag_augment', 'augment', el => el.prop('checked'));
    bind('#gf2_rag_rerank', 'useRerank', el => el.prop('checked'));
    bind('#gf2_rag_server', 'ragServer');
    bind('#gf2_rag_topk', 'topK', el => Number(el.val()) || 3);
    bind('#gf2_rag_minscore', 'minScore', el => Number(el.val()) || 0.35);
    bind('#gf2_rag_chat_base', 'chatBase');
    bind('#gf2_rag_chat_key', 'chatKey');
    bind('#gf2_rag_chat_model', 'chatModel');
    bind('#gf2_rag_embed_base', 'embedBase');
    bind('#gf2_rag_embed_key', 'embedKey');
    bind('#gf2_rag_embed_model', 'embedModel');
    bind('#gf2_rag_rerank_model', 'rerankModel');

    $('#gf2_rag_fetch_models').on('click', async () => {
        const st = $('#gf2_rag_status');
        st.text('正在拉取模型列表...');
        try {
            const srv = (cfg.ragServer || 'http://127.0.0.1:5240').replace(/\/+$/, '');
            const r = await fetch(`${srv}/models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseUrl: cfg.chatBase, apiKey: cfg.chatKey }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'failed');
            const dl = $('#gf2_rag_chat_model_list').empty();
            for (const m of j.models) dl.append(`<option value="${m}"></option>`);
            st.text(`已拉取 ${j.models.length} 个模型（点击模型输入框可下拉选择）`);
        } catch (e) {
            st.text('拉取失败: ' + e.message);
        }
    });

    $('#gf2_rag_save_srv').on('click', async () => {
        const st = $('#gf2_rag_status');
        try {
            const srv = (cfg.ragServer || 'http://127.0.0.1:5240').replace(/\/+$/, '');
            const r = await fetch(`${srv}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildApiConfig(cfg)),
            });
            const j = await r.json();
            st.text(j.ok ? '已保存到服务端 D:/gf2-work/gf2-rag/config.json' : ('保存失败: ' + j.error));
        } catch (e) {
            st.text('连接 :5240 失败: ' + e.message);
        }
    });

    $('#gf2_rag_test_btn').on('click', async () => {
        const q = prompt('输入测试查询语句：', '克莱妲在新威尼斯水下中了什么病毒');
        if (!q) return;
        const st = $('#gf2_rag_status');
        st.text('正在检索...');
        try {
            const srv = (cfg.ragServer || 'http://127.0.0.1:5240').replace(/\/+$/, '');
            const r = await fetch(`${srv}/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: q,
                    augment: cfg.augment,
                    useRerank: cfg.useRerank,
                    k: cfg.topK,
                    apiConfig: buildApiConfig(cfg),
                }),
            });
            const j = await r.json();
            const lines = [`耗时: ${j.took_ms}ms | 状态: ${j.rerank} | 关键词: ${(j.keywords || []).join(', ') || '无'}`];
            for (const h of j.results || []) {
                lines.push(`[${h.group} | 分数 ${h.score}] ${h.text.slice(0, 90).replace(/\n/g, ' ')}...`);
            }
            st.text(lines.join('\n'));
        } catch (e) {
            st.text('检索失败: ' + e.message);
        }
    });
});
