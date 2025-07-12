(function () {
    'use-strict';

    // --- 配置、常量与持久化 ---
    const SETTINGS_KEY = 'AI指引助手2.0变量';
    const SUGGESTION_CONTAINER_ID = 'ai-reply-suggestion-container';
    const LOG_PREFIX = '[回复建议插件]';

    const DEFAULT_SETTINGS = {
        apiKey: 'YOUR_API_KEY_HERE',
        baseUrl: 'https://api.studio.nebius.com/v1',
        model: 'google/gemma-3-27b-it-fast',
        activePromptIndex: 0,
        displayMode: 'wrap',
        characterBindings: {},
        prompts: [
            {
                name: '黄金三角建议 (【】符号)',
                content: `
# 角色
你是一个AI角色扮演助写引擎。

# 任务
你的任务是根据最新的对话上下文，为“用户”生成三条简短、有效、符合其角色风格的回复建议。

# 核心指令
1.  分析下方提供的[AI的回复]和[用户的回复]，理解当前情境和用户的说话风格。
2.  从以下三个不同角度生成建议：
    - **一条行动建议**：促使角色做出具体动作，推动剧情。
    - **一条提问建议**：用于探索信息或试探对方。
    - **一条反应建议**：表达角色的情感、态度或立场。
3.  严格遵守以下格式要求：
    - 每条建议不超过10个汉字。
    - 模仿[用户的回复]中的语气和风格。

# 输出格式
你必须只响应一个不换行的单行文本。每条建议都必须用【】符号包裹。不要包含任何序号、JSON或其他多余字符。

---
### 正确输出示例：
【拔出我的长剑！】【它好像受伤了？】【先找地方躲起来！】
---

# 对话上下文
[用户的回复]：
{{user_last_reply}}

[AI的回复]：
{{ai_last_reply}}


# 开始生成建议：
                `.trim(),
            },
        ],
    };

    let settings = { ...DEFAULT_SETTINGS };

    const SCRIPT_VERSION = '2.1.1';

    async function markUpdateNoticeSeen() {
        if (settings.lastSeenScriptVersion !== SCRIPT_VERSION) {
            settings.lastSeenScriptVersion = SCRIPT_VERSION;
            await saveSettings();
        }
    }

    // --- UI相关常量 ---
    const BUTTON_ID = 'suggestion-generator-ext-button';
    const PANEL_ID = 'suggestion-generator-settings-panel';
    const OVERLAY_ID = 'suggestion-generator-settings-overlay';
    const STYLE_ID = 'suggestion-generator-styles';
    const LOG_PANEL_ID = 'suggestion-generator-log-panel';

    const parentDoc = window.parent.document;
    const parent$ = window.parent.jQuery || window.parent.$;
    let panelElement = null; // 用于动态居中

    // --- 持久化与日志函数 ---
    function logMessage(message, type = 'info') { const logPanel = parent$(`#${LOG_PANEL_ID}`); const now = new Date(); const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`; const logEntry = parent$(`<div class="log-entry log-${type}"><span class="log-timestamp">[${timestamp}]</span> <span class="log-message">${message}</span></div>`); if (logPanel.length > 0) { logPanel.prepend(logEntry); } const consoleMessage = message.replace(/<[^>]*>/g, ''); switch (type) { case 'error': console.error(`${LOG_PREFIX} ${consoleMessage}`); break; case 'warn': console.warn(`${LOG_PREFIX} ${consoleMessage}`); break; case 'success': console.log(`${LOG_PREFIX} %c${consoleMessage}`, 'color: #28a745;'); break; default: console.log(`${LOG_PREFIX} ${consoleMessage}`); } }
    
    async function loadSettings() {
        if (typeof TavernHelper === 'undefined' || !TavernHelper.getVariables) {
            settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            return;
        }
        try {
            const globalVars = await TavernHelper.getVariables({ type: 'global' }) || {};
            const existingSettings = globalVars[SETTINGS_KEY];
            if (existingSettings && typeof existingSettings === 'object') {
                let mergedSettings = { ...DEFAULT_SETTINGS, ...existingSettings, prompts: existingSettings.prompts || DEFAULT_SETTINGS.prompts, characterBindings: existingSettings.characterBindings || DEFAULT_SETTINGS.characterBindings, };
                settings = mergedSettings;
            } else {
                settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
                await saveSettings();
            }
        } catch (error) {
            logMessage(`加载设置时发生错误: ${error.message}`, 'error');
            settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        }
    }

	async function saveSettings() {
        if (typeof TavernHelper === 'undefined' || typeof TavernHelper.updateVariablesWith !== 'function') { return; }
        try {
            await TavernHelper.updateVariablesWith(variables => {
                variables[SETTINGS_KEY] = settings;
                return variables;
            }, { type: 'global' });
        } catch (error) {
            logMessage(`保存设置时出错: ${error.message}`, 'error');
        }
    }
    
    // --- 核心逻辑 (无改动) ---
    function extractTextFromMessage(messageObj) { if (!messageObj || !messageObj.message) return ''; return parent$('<div>').html(messageObj.message.replace(/<br\s*\/?>/gi, '\n')).text().trim(); }
    async function callSuggestionAI(aiReply, userReply) {
        cleanupSuggestions();
        const activePrompt = settings.prompts[settings.activePromptIndex];
        if (!activePrompt) { logMessage('<b>[API调用]</b> 没有可用的活动提示词。', 'error'); return null; }
        const promptText = activePrompt.content.replace('{{ai_last_reply}}', aiReply).replace('{{user_last_reply}}', userReply);
        const sanitizedPrompt = parent$('<div>').text(promptText).html();
        logMessage(`<b>[最终提示词]</b> <pre class="final-prompt" style="white-space: pre-wrap;">${sanitizedPrompt}</pre>`, 'info');
        logMessage(`<b>[API调用]</b> 使用预设 "<b>${activePrompt.name}</b>" 调用AI...`);
        const body = { model: settings.model, messages: [{ role: 'user', content: promptText }], temperature: 0.8 };
        try {
            const response = await fetch(`${settings.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` }, body: JSON.stringify(body) });
            if (!response.ok) { 
                const errorText = await response.text();
                logMessage(`<b>[API响应]</b> <b>请求失败</b>, 状态码 <b>${response.status}</b>. <pre>${parent$('<div>').text(errorText).html()}</pre>`, 'error');
                return null;
            }
            const data = await response.json();
            const content = data.choices[0].message.content;
            logMessage(`<b>[AI原始返回]</b> <pre class="ai-raw-return">${parent$('<div>').text(content || '').html()}</pre>`, 'info');
            const filteredContent = (content && typeof content === 'string') ? content.replace(/<think>.*?<\/think>/gs, '').trim() : '';
            if (filteredContent) {
                const matches = filteredContent.match(/【(.*?)】/g) || [];
                const suggestions = matches.map(match => match.replace(/[【】]/g, '').trim()).filter(text => text.length > 0);
                if (suggestions.length > 0) { 
                    logMessage(`<b>[文本解析]</b> 成功解析 ${suggestions.length} 条建议。`, 'success');
                    return suggestions; 
                }
            }
            logMessage(`<b>[文本解析]</b> <b>AI返回的内容为空或格式不正确 (未找到【】)。</b>`, 'error');
            return null;
        } catch (error) { 
            logMessage(`<b>[API调用]</b> 发生网络或未知错误: ${error.message}`, 'error');
            return null;
        }
    }
    function renderSuggestions(suggestions) {
        cleanupSuggestions();
        const $sendForm = parent$('#send_form');
        if ($sendForm.length === 0) return;
        const $container = parent$(`<div id="${SUGGESTION_CONTAINER_ID}"></div>`);
        if (settings.displayMode === 'wrap') { $container.addClass('sg-mode-wrap'); } else { $container.addClass('sg-mode-scroll'); }
        suggestions.forEach(text => {
            // 【修正】: 恢复为原始的按钮样式类
            const $capsule = parent$(`<button class="qr--button menu_button interactable suggestion-capsule">${text}</button>`);
            $capsule.on('click', function() { sendSuggestionText(text); cleanupSuggestions(); });
            $container.append($capsule);
        });
        $sendForm.prepend($container); 
        logMessage(`已在界面上渲染 ${suggestions.length} 条建议。`, 'success');
        if(typeof eventOnce !== 'undefined' && typeof tavern_events !== 'undefined'){ eventOnce( tavern_events.MESSAGE_SENT, cleanupSuggestions); eventOnce( tavern_events.MESSAGE_DELETED, cleanupSuggestions); eventOnce( tavern_events.MESSAGE_SWIPED, cleanupSuggestions); eventOnce( tavern_events.CHAT_CHANGED, cleanupSuggestions);}
    }
    async function sendSuggestionText(text) { if (typeof TavernHelper === 'undefined' || typeof TavernHelper.triggerSlash !== 'function') { return; } const tempVarName = `suggestion_text_${Date.now()}`; const commandChain = `/setvar key=${tempVarName} ${JSON.stringify(text)} | /send {{getvar::${tempVarName}}} | /trigger | /flushvar ${tempVarName}`.trim().replace(/\s+/g, ' '); try { await TavernHelper.triggerSlash(commandChain); } catch (error) { logMessage(`执行命令链时出错: ${error.message}`, 'error'); } }
    function cleanupSuggestions() { parent$(`#${SUGGESTION_CONTAINER_ID}`).remove(); }
    async function triggerSuggestionGeneration() {
        try {
            parent$(`#${LOG_PANEL_ID}`).empty();
            logMessage("---- 开始新一轮建议生成 (日志已清空) ----", 'info');
            if (typeof getChatMessages !== 'function' || typeof getLastMessageId !== 'function') {
                logMessage('<b>[兼容性问题]</b> 核心函数 `getChatMessages` 或 `getLastMessageId` 未找到。', 'error');
                return;
            }
            const lastMessageId = getLastMessageId();
            if (lastMessageId < 1) {
                logMessage("聊天记录不足两条，跳过生成。", 'warn');
                return;
            }
            const range = `${lastMessageId - 1}-${lastMessageId}`;
            logMessage(`准备使用范围 "${range}" 获取最后两条消息...`, 'info');
            const lastTwoMessages = getChatMessages(range);
            if (!lastTwoMessages || lastTwoMessages.length < 2) {
                logMessage(`通过API范围查询获取到的消息不足两条 (实际获取到 ${lastTwoMessages?.length || 0} 条)，跳过。`, 'warn');
                return;
            }
            const [userMessage, aiMessage] = lastTwoMessages;
            if (!userMessage || userMessage.role !== 'user' || !aiMessage || aiMessage.role !== 'assistant') {
                logMessage(`最后两条消息的角色不符合 'user' -> 'assistant' 顺序，跳过。 (检测到: ${userMessage?.role} -> ${aiMessage?.role})`, 'warn');
                return;
            }
            const userText = extractTextFromMessage(userMessage);
            const aiText = extractTextFromMessage(aiMessage);
            if (!userText || !aiText) {
                logMessage("未能成功提取用户或AI的文本内容，跳过。", 'warn');
                return;
            }
            logMessage("成功获取上下文，准备调用API...", 'info');
            const suggestions = await callSuggestionAI(aiText, userText);
            if (suggestions && suggestions.length > 0) {
                renderSuggestions(suggestions);
            }
        } catch (error) {
            logMessage(`生成建议时发生未知错误: ${error.message}`, 'error');
        }
    }
    async function applyCharacterBinding() {
        const currentChar = TavernHelper.getCharData();
        if (!currentChar) return;
        const charId = currentChar.avatar;
        const charName = currentChar.name;
        let targetIndex = 0;
        let isBound = false;
        if (settings.characterBindings && settings.characterBindings.hasOwnProperty(charId)) {
            const boundIndex = settings.characterBindings[charId];
            if (boundIndex >= 0 && boundIndex < settings.prompts.length) {
                targetIndex = boundIndex;
                isBound = true;
            } else {
                delete settings.characterBindings[charId];
            }
        }
        if (settings.activePromptIndex !== targetIndex) {
            settings.activePromptIndex = targetIndex;
            if (isBound) {
                logMessage(`切换角色: "<b>${charName}</b>"。已自动应用绑定预设: "<b>${settings.prompts[targetIndex].name}</b>"。`, 'success');
            } else {
                logMessage(`切换角色: "<b>${charName}</b>"。无有效绑定，使用默认预设: "<b>${settings.prompts[targetIndex].name}</b>"。`, 'info');
            }
            await saveSettings();
        }
        updateUIPanel();
    }

    // --- UI 创建与事件绑定 ---
    function cleanupOldUI() { parent$(`#${BUTTON_ID}, #${OVERLAY_ID}, #${STYLE_ID}`).remove(); }

    function centerPanel() {
        if (!panelElement) return;
        const windowWidth = window.parent.innerWidth || parentDoc.documentElement.clientWidth;
        const windowHeight = window.parent.innerHeight || parentDoc.documentElement.clientHeight;
        const panelWidth = panelElement.offsetWidth;
        const panelHeight = panelElement.offsetHeight;
        const left = Math.max(0, (windowWidth - panelWidth) / 2);
        const top = Math.max(0, (windowHeight - panelHeight) / 2);
        panelElement.style.left = `${left}px`;
        panelElement.style.top = `${top}px`;
    }

    function injectStyles() {
        if (parent$(`#${STYLE_ID}`).length > 0) return;
        const styles = `<style id="${STYLE_ID}">
            /* 动画 */
            @keyframes sgFadeIn {
                from { opacity: 0; transform: translateY(-20px) scale(0.95); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }

            /* 遮罩层 */
            #${OVERLAY_ID} {
                position: fixed; top: 0; left: 0;
                width: 100vw; height: 100vh;
                background-color: rgba(0, 0, 0, 0.5);
                backdrop-filter: blur(5px);
                z-index: 10000;
                display: none; pointer-events: auto;
            }

            /* 设置面板 */
            #${PANEL_ID} {
                position: fixed; display: flex; flex-direction: column;
                width: 90%; max-width: 750px;
                height: 85vh; max-height: 800px;
                background: var(--SmartThemeBlurTintColor, #1a1a1c);
                color: var(--SmartThemeBodyColor, #e0e0e0);
                border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
                border-radius: 12px;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3), 0 8px 16px rgba(0, 0, 0, 0.2);
                animation: sgFadeIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                overflow: hidden; z-index: 10001;
            }
            #${PANEL_ID} .panel-header {
                padding: 10px 20px;
                border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
                display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
            }
            #${PANEL_ID} .panel-header h4 { margin: 0; font-size: 16px; font-weight: 600; color: var(--SmartThemeBodyColor, #ffffff); }
            #${PANEL_ID} .panel-close-btn {
                background: transparent; border: none; color: var(--SmartThemeBodyColor, #aaa);
                font-size: 24px; font-weight: 300; cursor: pointer; padding: 8px; line-height: 1;
                transition: all 0.2s ease; border-radius: 50%;
                width: 40px; height: 40px;
                display: flex; align-items: center; justify-content: center;
            }
            #${PANEL_ID} .panel-close-btn:hover { color: var(--SmartThemeBodyColor, #fff); background: rgba(255, 255, 255, 0.1); transform: scale(1.1); }
            #${PANEL_ID} .panel-nav {
                display: flex; padding: 0 15px;
                border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
                background: rgba(0,0,0,0.1); flex-shrink: 0;
            }
            #${PANEL_ID} .panel-nav-item {
                padding: 12px 18px; cursor: pointer;
                color: var(--SmartThemeBodyColor, rgba(255, 255, 255, 0.7));
                border-bottom: 3px solid transparent; transition: all .2s ease-in-out;
                font-weight: 500; font-size: 14px;
            }
            #${PANEL_ID} .panel-nav-item:hover { color: var(--SmartThemeBodyColor, #ffffff); background-color: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, 0.05)); }
            #${PANEL_ID} .panel-nav-item.active { color: var(--SmartThemeBodyColor, #ffffff); border-bottom-color: var(--SmartThemeQuoteColor, #4a9eff); }
            #${PANEL_ID} .panel-content-wrapper { flex: 1; min-height: 0; display: flex; flex-direction: column; }
            #${PANEL_ID} .panel-content { display: none; flex: 1; min-height: 0; overflow-y: auto; padding: 24px; }
            #${PANEL_ID} .panel-content.active { display: block; }
            #${PANEL_ID} .form-group { margin-bottom: 20px; }
            #${PANEL_ID} label { display: block; margin-bottom: 8px; color: var(--SmartThemeBodyColor, #e0e0e0); font-weight: 500; font-size: 14px; }
            #${PANEL_ID} input[type=text], #${PANEL_ID} input[type=password], #${PANEL_ID} textarea, .sg-select-box {
                width: 100%;
                background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, 0.05));
                color: var(--SmartThemeBodyColor, #ffffff);
                border: 2px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
                border-radius: 10px; padding: 12px 16px; box-sizing: border-box;
                font-size: 14px; transition: all 0.3s ease;
            }
            #${PANEL_ID} textarea { min-height: 150px; resize: vertical; line-height: 1.6; }
            #${PANEL_ID} input:focus, #${PANEL_ID} textarea:focus, .sg-select-box:focus {
                outline: none; border-color: var(--SmartThemeQuoteColor, #4a9eff);
                background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, 0.08));
                box-shadow: 0 0 0 3px var(--SmartThemeQuoteColor, rgba(74, 158, 255, 0.2));
            }
            .prompt-item-container { border: 1px solid transparent; border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
            .prompt-item { display: flex; align-items: center; padding: 12px 15px; background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, 0.03)); }
            .prompt-item.active { border-left: 4px solid var(--SmartThemeQuoteColor, #4a9eff); padding-left: 11px; background-color: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, 0.08)); }
            .prompt-item-name { flex-grow: 1; }
            .prompt-item-name input { font-weight: 600; }
            .prompt-item-actions { display: flex; gap: 8px; }
            .prompt-content-textarea { border-top: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1)); border-radius: 0 0 10px 10px; border-width: 1px 0 0 0; }
            
            /* 【修正】面板内按钮样式 */
            .sg-button {
                background: var(--SmartThemeQuoteColor, #4a9eff); color: var(--SmartThemeBodyColor, #ffffff);
                padding: 6px 16px; border: none; border-radius: 8px; cursor: pointer;
                font-size: 14px; font-weight: 500; transition: all 0.2s ease;
                box-shadow: 0 2px 8px rgba(74, 158, 255, 0.2);
            }
            .sg-button:hover { background: var(--SmartThemeQuoteColor, #3d8bff); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(74, 158, 255, 0.3); }
            .sg-button.secondary { background: var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1)); box-shadow: none; }
            .sg-button.secondary:hover { background: rgba(255, 255, 255, 0.15); }
            .sg-button.danger { background:rgb(240, 75, 89); box-shadow: 0 2px 8px rgba(255, 71, 87, 0.2); }
            .sg-button.danger:hover { background:rgb(220, 60, 75); box-shadow: 0 4px 12px rgba(255, 71, 87, 0.3); }
            .prompt-item-actions .sg-button { padding: 5px 10px; font-size: 12px; }

            /* 日志面板 */
            #${LOG_PANEL_ID} {
                background-color: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.1));
                font-family: monospace;
                font-size: 13px;
                color: var(--SmartThemeBodyColor, #e0e0e0);
            }
            /* 新增：让 .log-message 默认自适应主题色 */
            #${LOG_PANEL_ID} .log-message {
                color: var(--SmartThemeBodyColor, #e0e0e0);
            }
            .log-entry { 
                margin-bottom: 8px; padding: 5px 10px; 
                border-left: 3px solid var(--SmartThemeBorderColor, #444); 
                border-radius: 4px; background: rgba(0,0,0,0.1);
                /* 【修正】: 确保所有日志文本颜色都是自适应的 */
                color: var(--SmartThemeBodyColor, #e0e0e0);
            }
            .log-entry.log-error { border-left-color: rgb(240, 75, 89); background: rgba(240, 75, 89, 0.1); }
            .log-entry.log-success { border-left-color: #28a745; background: rgba(40, 167, 69, 0.1); }
            .log-entry.log-warn { border-left-color: #ffc107; background: rgba(255, 193, 7, 0.1); }
            #${LOG_PANEL_ID} .log-message b {
                color: var(--SmartThemeQuoteColor, #00aaff);
            }
            /* 清除原来给所有 <pre> 强制的字体色 */
            #${LOG_PANEL_ID} .log-message pre { white-space: pre-wrap; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; margin-top: 5px; }

            /* AI 原生返回：蓝色 */
            #${LOG_PANEL_ID} .log-message pre.ai-raw-return {
                color: var(--SmartThemeQuoteColor, #00aaff) !important;
            }
            /* 最终提示词：紫色 */
            #${LOG_PANEL_ID} .log-message pre.final-prompt {
                color: var(--SmartThemeQuoteColor, #c8a2c8) !important;
            }

            #${SUGGESTION_CONTAINER_ID} {
                margin: 0;
                padding: 5px 0;
                width: 100%;
                box-sizing: border-box;
                display: flex;
            }
            #${SUGGESTION_CONTAINER_ID} .suggestion-capsule {
                width: auto;
                white-space: nowrap;
                flex-shrink: 0;
                margin: 0 !important;
            }
            #${SUGGESTION_CONTAINER_ID}.sg-mode-scroll {
                justify-content: flex-start;
                overflow-x: auto;
                gap: 5px;
                scrollbar-width: none;
                -ms-overflow-style: none;
            }
            #${SUGGESTION_CONTAINER_ID}.sg-mode-scroll::-webkit-scrollbar {
                display: none;
            }
            #${SUGGESTION_CONTAINER_ID}.sg-mode-scroll::before,
            #${SUGGESTION_CONTAINER_ID}.sg-mode-scroll::after {
                content: '';
                flex-grow: 1;
            }
            #${SUGGESTION_CONTAINER_ID}.sg-mode-wrap {
                flex-wrap: wrap;
                justify-content: center;
                column-gap: 5px;
                row-gap: 5px;
            }
            /* —— 以上块结束 —— */
        </style>`;
        parent$(parentDoc.head).append(styles);
    }

    function createAndInjectUI() {
        if (parent$(`#extensionsMenu`).length > 0 && parent$(`#${BUTTON_ID}`).length === 0) {
            parent$('<div/>', { id: BUTTON_ID, class: 'list-group-item flex-container flexGap5 interactable', html: `<i class="fa-solid fa-lightbulb"></i><span>AI指引助手</span>` }).appendTo(parent$(`#extensionsMenu`));
        }
        if (parent$(`#${OVERLAY_ID}`).length === 0) {
            const displayModeHtml = `<div class="form-group"><label for="sg-display-mode-select">显示模式:</label><select id="sg-display-mode-select" class="sg-select-box"><option value="scroll">模式A: 水平滚动</option><option value="wrap">模式B: 多行换行</option></select></div>`;
            const helpContentHtml = `<div style="line-height: 1.6;"><h4>欢迎使用AI指引助手！</h4><p>本脚本会在AI角色回复后，自动调用您指定的AI模型，根据最新的对话上下文，生成若干条符合您角色风格的回复建议，并显示在输入框上方，供您快速选择。</p><hr><h5>核心功能</h5><p>每次AI完成生成后，插件会自动执行以下操作：</p><ul><li>获取最后两条消息（您的上一条回复和AI的最新回复）。</li><li>将这两条消息填入您在“预设”中设置的模板。</li><li>使用“API与显示”中配置的密钥、地址和模型，向AI服务商发起请求。</li><li>解析AI返回的内容，提取所有被 <code>【】</code> 符号包裹的文本作为建议。</li><li>将建议按钮显示在输入框上方。</li></ul><hr><h5>面板说明</h5><p><strong>1. API与显示</strong></p><ul><li><strong>API Key:</strong> 您的AI服务商提供的密钥，会以密码形式显示。</li><li><strong>Base URL:</strong> AI服务的API地址，例如 <code>https://api.openai.com/v1</code>。</li><li><strong>Model:</strong> 您希望用来生成建议的AI模型名称，例如 <code>gpt-4o-mini</code>。</li><li><strong>显示模式:</strong><ul><li><strong>模式A (水平滚动):</strong> 建议按钮会排成一行，如果超出宽度可以水平滚动。界面更紧凑。</li><li><strong>模式B (多行换行):</strong> 建议按钮会自动换行，适合建议较长或数量较多的情况。</li></ul></li></ul><p><strong>2. 预设</strong></p><ul><li><strong>列表:</strong> 您可以创建多个不同的预设提示词，用于不同的场景或角色。</li><li><strong>使用按钮:</strong> 点击后，会将当前预设与<strong>当前聊天角色</strong>进行绑定。下次切换回这个角色时，插件会自动激活这个预设。</li><li><strong>删除按钮:</strong> 删除预设。如果该预设是某个角色的绑定，该角色将恢复使用默认预设。</li><li><strong>添加新预设:</strong> 在列表底部创建一个新的空白预设。</li></ul><p><strong>3. 日志</strong></p><ul><li>这里会详细记录最新一次建议生成过程中的所有步骤、API请求、AI返回的原始数据以及解析结果。</li><li>如果插件没有按预期工作，请先检查此处的错误信息，特别是 <strong><span style="color: #ff6347;">[最终提示词]</span></strong> 和 <strong>[AI原始返回]</strong> 部分。</li></ul><hr><h5><span style="color: #ffc107;">【重要】如何编写有效的提示词</span></h5><p>为了让插件正确工作，您的提示词必须引导AI返回特定格式的文本。</p><ol><li><strong>必须包含占位符:</strong> 您的提示词中应包含<code>{{user_last_reply}}</code> 和 <code>{{ai_last_reply}}</code>，插件会自动用最新的对话内容替换它们，为AI提供上下文（注意：顺序是先用户后AI）。</li><li><strong>必须指定输出格式:</strong> 您必须在提示词中明确要求AI将每条建议都用全角方括号 <code>【】</code> 包裹起来，并且所有建议都在一行内输出，不要添加序号、换行或其他无关字符。</li></ol><p><strong>正确输出示例 (AI应返回这样的单行文本):</strong></p><code style="background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor); padding: 4px 8px; border-radius: 4px; display: block;">【拔出我的长剑！】【它好像受伤了？】【先找地方躲起来！】</code><p><strong>错误输出示例:</strong></p><code style="background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor); padding: 4px 8px; border-radius: 4px; display: block; margin-bottom: 5px;">1.【拔出我的长剑！】 2.【它好像受伤了？】</code><code style="background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor); padding: 4px 8px; border-radius: 4px; display: block;">{"suggestions": ["拔出我的长剑！", "它好像受伤了？"]}</code><p>如果AI返回了错误格式，插件将无法解析出任何建议。请根据“日志”中的“AI原始返回”内容，调整您的提示词，直到AI能够稳定输出正确格式为止。</p></div>`;
            const $overlay = parent$('<div/>', { id: OVERLAY_ID });
            const $panel = parent$(`<div id="${PANEL_ID}"><div class="panel-header"><h4>AI指引助手 - 设置</h4><button class="panel-close-btn">×</button></div><div class="panel-nav"><div class="panel-nav-item active" data-tab="api">API</div><div class="panel-nav-item" data-tab="prompts">预设</div><div class="panel-nav-item" data-tab="logs">日志</div><div class="panel-nav-item" data-tab="help">使用说明</div></div><div class="panel-content-wrapper"><div id="sg-panel-api" class="panel-content active"><div class="form-group"><label for="sg-api-key">API Key:</label><input type="password" id="sg-api-key"></div><div class="form-group"><label for="sg-base-url">Base URL:</label><input type="text" id="sg-base-url"></div><div class="form-group"><label for="sg-model">Model:</label><input type="text" id="sg-model"></div>${displayModeHtml}</div><div id="sg-panel-prompts" class="panel-content"><div id="sg-prompt-list"></div><button id="sg-add-prompt-btn" class="sg-button secondary" style="width:100%;">添加新预设</button></div><div id="${LOG_PANEL_ID}" class="panel-content" data-tab-name="logs"></div><div id="sg-panel-help" class="panel-content">${helpContentHtml}</div></div></div>`);
            $overlay.append($panel).appendTo(parent$('body'));
            panelElement = $panel[0];
        }
    }

    function updateUIPanel() {
        const $apiPanel = parent$('#sg-panel-api');
        $apiPanel.find('.update-notice').remove();
        if (settings.lastSeenScriptVersion !== SCRIPT_VERSION) {
            const noticeHtml = `<div class="form-group update-notice" style="padding: 15px; border-radius: 8px; border: 1px solid var(--SmartThemeQuoteColor); background: rgba(74, 158, 255, 0.1);"><span style="color: var(--SmartThemeQuoteColor); font-weight: bold;">脚本已更新至 ${SCRIPT_VERSION} 版本。</span><br><br><span style="color: #dc3545; font-weight: bold;">重要说明：</span><br><span>请大家务必将预设提示词中的 <b style="background-color: #dc3545; padding: 2px 4px; border-radius: 3px;">{{user_last_reply}}</b> 和 <b style="background-color: #dc3545; padding: 2px 4px; border-radius: 3px;">{{ai_last_reply}}</b> 及前缀进行互换位置。因为聊天消息的上下文顺序是用户在前，AI消息在后，但之前版本的默认预设提示词写反了 o(╥﹏╥)o。</span><br><br><span>此外，实际发送的上下文可以直接在 <b style="color: var(--SmartThemeQuoteColor);">“日志”面板</b> 查看。<br><span style="font-size: 0.9em;">如果是新用户可不用在意，因为新版本已经将默认提示词的发送顺序改了回来，但安装过旧版本脚本更新后无法直接修正提示词的顺序。</span><br><span style="font-size: 0.8em;">（该更新信息在关闭UI后将不再显示）</span></span></div>`;
            $apiPanel.find('#sg-display-mode-select').closest('.form-group').after(noticeHtml);
        }
        parent$('#sg-api-key').val(settings.apiKey);
        parent$('#sg-base-url').val(settings.baseUrl);
        parent$('#sg-model').val(settings.model);
        parent$('#sg-display-mode-select').val(settings.displayMode);
        const $promptList = parent$('#sg-prompt-list').empty();
        settings.prompts.forEach((prompt, index) => {
            const $item = parent$(`<div class="prompt-item-container"><div class="prompt-item ${index === settings.activePromptIndex ? 'active' : ''}"><div class="prompt-item-name"><input type="text" class="prompt-name-input" value="${prompt.name}" data-index="${index}"></div><div class="prompt-item-actions"><button class="sg-button prompt-use-btn" data-index="${index}">使用</button><button class="sg-button danger prompt-delete-btn" data-index="${index}">删除</button></div></div><div class="form-group"><textarea class="prompt-content-textarea" data-index="${index}">${prompt.content}</textarea></div></div>`);
            $promptList.append($item);
        });
    }

    function bindEvents() {
        const parentBody = parent$('body');
        parentBody.on('click', `#${BUTTON_ID}`, (event) => {
            event.stopPropagation();
            updateUIPanel();
            parent$(`#${OVERLAY_ID}`).css('display', 'block');
            centerPanel();
            parent$(window.parent).on('resize.sg', centerPanel);
        });
        parentBody.on('click', `#${OVERLAY_ID}`, async function (e) {
            if (e.target.id === OVERLAY_ID || parent$(e.target).hasClass('panel-close-btn')) {
                await markUpdateNoticeSeen();
                parent$(`#${OVERLAY_ID}`).hide();
                parent$(window.parent).off('resize.sg');
            }
        });
        parentBody.on('click', `#${PANEL_ID} .panel-nav-item`, function () {
            const tab = parent$(this).data('tab');
            parent$(`#${PANEL_ID} .panel-nav-item`).removeClass('active');
            parent$(this).addClass('active');
            parent$(`#${PANEL_ID} .panel-content`).removeClass('active');
            parent$(`#sg-panel-${tab}, [data-tab-name='${tab}']`).addClass('active');
        });
        parentBody.on('change', '#sg-api-key, #sg-base-url, #sg-model, #sg-display-mode-select', async function () {
            settings.apiKey = parent$('#sg-api-key').val();
            settings.baseUrl = parent$('#sg-base-url').val();
            settings.model = parent$('#sg-model').val();
            settings.displayMode = parent$('#sg-display-mode-select').val();
            await saveSettings();
        });
        parentBody.on('click', '#sg-add-prompt-btn', async () => {
            settings.prompts.push({ name: '新预设', content: '在这里输入你的提示词...' });
            updateUIPanel();
            await saveSettings();
        });
        parentBody.on('click', `#${PANEL_ID} .prompt-use-btn`, async function () {
            const index = parseInt(parent$(this).data('index'));
            const currentChar = TavernHelper.getCharData();
            if (currentChar) {
                const charId = currentChar.avatar;
                const charName = currentChar.name;
                if (!settings.characterBindings) settings.characterBindings = {};
                settings.characterBindings[charId] = index;
                settings.activePromptIndex = index;
                await saveSettings();
                updateUIPanel();
                logMessage(`操作: 已将角色 "<b>${charName}</b>" 绑定到预设 "<b>${settings.prompts[index].name}</b>"。`, 'success');
            } else {
                logMessage('无法获取当前角色ID，绑定失败。', 'warn');
            }
        });
        parentBody.on('click', `#${PANEL_ID} .prompt-delete-btn`, async function () {
            const indexToDelete = parseInt(parent$(this).data('index'));
            if (settings.prompts.length <= 1) {
                logMessage('不能删除最后一个预设。', 'warn');
                return;
            }
            if (confirm(`确定要删除预设 "${settings.prompts[indexToDelete].name}" 吗? 这会解除所有角色与此预设的绑定。`)) {
                settings.prompts.splice(indexToDelete, 1);
                if(settings.characterBindings) {
                    const newBindings = {};
                    for(const charId in settings.characterBindings) {
                        const boundIndex = settings.characterBindings[charId];
                        if(boundIndex === indexToDelete) { continue; }
                        else if (boundIndex > indexToDelete) { newBindings[charId] = boundIndex - 1; }
                        else { newBindings[charId] = boundIndex; }
                    }
                    settings.characterBindings = newBindings;
                }
                await applyCharacterBinding();
                logMessage(`已删除预设，并更新了所有相关绑定。`, 'success');
            }
        });
        parentBody.on('change', `#${PANEL_ID} .prompt-name-input, #${PANEL_ID} .prompt-content-textarea`, async function () {
            const index = parseInt(parent$(this).data('index'));
            const isName = parent$(this).hasClass('prompt-name-input');
            if (isName) {
                settings.prompts[index].name = parent$(this).val();
            } else {
                settings.prompts[index].content = parent$(this).val();
            }
            await saveSettings();
        });
        if (typeof eventOn !== 'undefined' && typeof tavern_events !== 'undefined') {
            eventOn(tavern_events.GENERATION_ENDED, triggerSuggestionGeneration);
            eventOn(tavern_events.CHAT_CHANGED, applyCharacterBinding);
        } else {
            logMessage('SillyTavern 事件系统未找到，核心功能可能无法自动触发。', 'error');
        }
    }

    // --- 初始化 ---
    function init() { if (!parent$) { return; } cleanupOldUI(); injectStyles(); createAndInjectUI(); loadSettings().then(() => { bindEvents(); applyCharacterBinding(); logMessage("AI指引助手 初始化完成。", "success"); }); }
    if (typeof (window.parent.jQuery || window.parent.$) === 'function' && typeof TavernHelper !== 'undefined' && typeof TavernHelper.getCharData === 'function') { setTimeout(init, 2000); } else { console.error(`${LOG_PREFIX} 等待父窗口jQuery或TavernHelper超时，脚本可能无法正常工作。`); }

})();
