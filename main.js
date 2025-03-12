// 基础导入
import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { HttpsProxyAgent } from 'https-proxy-agent';

dotenv.config();

const app = express();
app.use(express.json({ limit: '20mb' }));

// 环境变量配置
const {
    PROXY_PORT,
    PROXY_URL,
    PROXY_URL2,
    Model_think_API_KEY,
    Model_think_MODEL,
    Model_think_MAX_TOKENS,
    Model_think_TEMPERATURE,
    Model_think_WebSearch,
    Think_PROMPT,
    Model_output_API_KEY,
    Model_output_MODEL,
    Model_output_MAX_TOKENS,
    Model_output_TEMPERATURE,
    Model_output_WebSearch,
    RELAY_PROMPT,
    HYBRID_MODEL_NAME,
    OUTPUT_API_KEY,
    Show_COT
} = process.env;

// 用于存储当前任务的信息
let currentTask = null;

// API 密钥验证中间件
const apiKeyAuth = (req, res, next) => {
    const apiKey = req.headers.authorization;

    if (!apiKey || apiKey !== `Bearer ${OUTPUT_API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
    }
    next();
};

// 简化的取消任务函数
function cancelCurrentTask() {
    if (!currentTask) {
        return;
    }

    console.log('收到新请求，取消当前任务...');
    
    try {
        if (currentTask.cancelTokenSource) {
            currentTask.cancelTokenSource.cancel('收到新请求');
        }
        
        if (currentTask.res && !currentTask.res.writableEnded) {
            currentTask.res.write('data: {"choices": [{"delta": {"content": "\n\n[收到新请求，开始重新生成]"}, "index": 0, "finish_reason": "stop"}]}\n\n');
            currentTask.res.write('data: [DONE]\n\n');
            currentTask.res.end();
        }

        currentTask = null;
    } catch (error) {
        console.error('取消任务时出错:', error);
        currentTask = null;
    }
}

// 修改主请求处理函数
app.post('/v1/chat/completions', apiKeyAuth, async (req, res) => {
    // 确保取消之前的任务
    if (currentTask) {
        console.log('存在正在进行的任务，准备取消...');
        cancelCurrentTask();
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('开始处理新请求...');
    
    const cancelTokenSource = axios.CancelToken.source();
    currentTask = { 
        res,
        cancelTokenSource,
        thinkingSent: false // 标记是否已发送思考内容
    };

    try {
        const originalRequest = req.body;
        const messages = [...originalRequest.messages].map(msg => {
            // 处理消息中的多模态内容
            if (msg.content && Array.isArray(msg.content)) {
                return {
                    ...msg,
                    content: msg.content.map(content => {
                        if (content.type === 'text') {
                            return content;
                        } else if (content.type === 'image_url') {
                            // 处理图片URL
                            return {
                                type: 'image_url',
                                image_url: {
                                    url: content.image_url.url
                                }
                            };
                        } else if (content.type === 'file_url') {
                            // 处理文件URL
                            return {
                                type: 'file_url',
                                file_url: {
                                    url: content.file_url.url,
                                    mime_type: content.file_url.mime_type
                                }
                            };
                        }
                        return content;
                    })
                };
            }
            return msg;
        });
        const stream = originalRequest.stream ?? true; // 默认为流式输出
        
        // 检查模型
        const requestedModel = originalRequest.model;
        if (requestedModel !== HYBRID_MODEL_NAME) {
            throw new Error(`不支持的模型: ${requestedModel}`);
        }

        // 思考阶段
        const thinkingMessages = [
            ...messages,
            { 
                role: "user",  // 将 system 改为 user
                content: Think_PROMPT 
            }
        ];

        // 简化思考阶段配置
        const thinkingConfig = {
            model: Model_think_MODEL,
            messages: thinkingMessages,
            temperature: parseFloat(Model_think_TEMPERATURE),
            stream: stream // 使用客户端请求的流式设置
        };

        if (Model_think_WebSearch === 'true') {
            thinkingConfig.tools = [{
                type: "function",
                function: {
                    name: "googleSearch",
                    description: "Search the web for relevant information",
                    parameters: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "The search query"
                            }
                        },
                        required: ["query"]
                    }
                }
            }];
        }

        // 在执行思考阶段之前添加日志
        console.log('思考阶段配置:', {
            model: thinkingConfig.model,
            temperature: thinkingConfig.temperature,
            messageCount: thinkingConfig.messages.length
        });

        // 执行思考阶段
        let thinkingContent = '';
        
        if (stream) {
            // 流式思考阶段
            const thinkingResponse = await axios.post(
                `${PROXY_URL}/v1/chat/completions`,
                thinkingConfig,
                {
                    headers: {
                        Authorization: `Bearer ${Model_think_API_KEY}`,
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream'
                    },
                    responseType: 'stream',
                    cancelToken: cancelTokenSource.token,
                    timeout: 30000,
                    validateStatus: function (status) {
                        return status >= 200 && status < 300;
                    }
                }
            );
            
            // 收集思考内容并实时发送给客户端
            const thinkingChunks = [];
            let isFirstThinkingChunk = true;
            
            // 设置SSE响应头
            if (Show_COT === 'true' && !res.headersSent) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });
            }
            
            await new Promise((resolve, reject) => {
                thinkingResponse.data.on('data', chunk => {
                    try {
                        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                        
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const data = line.slice(6);
                                if (data === '[DONE]') {
                                    continue;
                                }
                                
                                try {
                                    const parsed = JSON.parse(data);
                                    const content = parsed.choices[0]?.delta?.content || '';
                                    
                                    if (content) {
                                        thinkingChunks.push(content);
                                        
                                        // 如果需要显示思考内容，实时发送给客户端
                                        if (Show_COT === 'true') {
                                            // 简化的流式日志
                                            process.stdout.write(content);
                                            
                                            // 为第一个思考块添加<think>标签
                                            let outputContent = content;
                                            if (isFirstThinkingChunk) {
                                                outputContent = `<think>${content}`;
                                                isFirstThinkingChunk = false;
                                            }
                                            
                                            const formattedChunk = {
                                                id: `chatcmpl-${Date.now()}`,
                                                object: 'chat.completion.chunk',
                                                created: Math.floor(Date.now() / 1000),
                                                model: HYBRID_MODEL_NAME,
                                                choices: [{
                                                    delta: { content: outputContent },
                                                    index: 0,
                                                    finish_reason: null
                                                }]
                                            };
                                            res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
                                        }
                                    }
                                } catch (parseError) {
                                    console.error('解析思考响应失败:', parseError.message);
                                }
                            }
                        }
                    } catch (error) {
                        console.error('处理思考响应出错:', error.message);
                    }
                });
                
                thinkingResponse.data.on('error', error => {
                    console.error('思考流错误:', error);
                    reject(error);
                });
                
                thinkingResponse.data.on('end', () => {
                    console.log('思考流结束');
                    // 如果需要显示思考内容，添加思考结束标签
                    if (Show_COT === 'true' && !isFirstThinkingChunk) {
                        const formattedChunk = {
                            id: `chatcmpl-${Date.now()}`,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: HYBRID_MODEL_NAME,
                            choices: [{
                                delta: { content: '</think>\n\n' },
                                index: 0,
                                finish_reason: null
                            }]
                        };
                        res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
                    }
                    resolve();
                });
            });
            
            thinkingContent = thinkingChunks.join('');
            console.log('思考阶段内容收集完成');
            
            // 标记思考内容已发送
            if (Show_COT === 'true') {
                currentTask.thinkingSent = true;
            }
        } else {
            // 非流式思考阶段
            const thinkingResponse = await axios.post(
                `${PROXY_URL}/v1/chat/completions`,
                thinkingConfig,
                {
                    headers: {
                        Authorization: `Bearer ${Model_think_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    cancelToken: cancelTokenSource.token,
                    timeout: 30000,
                    validateStatus: function (status) {
                        return status >= 200 && status < 300;
                    }
                }
            );

            console.log('思考阶段响应:', JSON.stringify(thinkingResponse.data, null, 2));
            thinkingContent = thinkingResponse.data.choices[0].message.content;
        }
        
        // 保存思考内容，用于后续处理
        const originalThinkingContent = thinkingContent;

        // 修改输出阶段的消息构建
        const outputMessages = [
            {
                role: "system",
                content: RELAY_PROMPT
            },
            {
                role: "user",
                content: messages[messages.length - 1].content // 原始问题
            },
            {
                role: "user",  // 将 assistant 改为 user
                content: thinkingContent
            }
        ];

        // 修改输出阶段的配置
        const outputConfig = {
            model: Model_output_MODEL,
            messages: outputMessages,
            temperature: parseFloat(Model_output_TEMPERATURE),
            stream: stream,
            max_tokens: parseInt(Model_output_MAX_TOKENS) // 添加最大token限制
        };

        if (Model_output_WebSearch === 'true') {
            outputConfig.tools = [{
                type: "function",
                function: {
                    name: "googleSearch",
                    description: "Search the web for relevant information",
                    parameters: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "The search query"
                            }
                        },
                        required: ["query"]
                    }
                }
            }];
        }

        // 添加更多日志来追踪输出阶段
        console.log('准备输出阶段配置:', JSON.stringify(outputConfig, null, 2));

        // 修改流式输出处理
        if (stream) {
            console.log('开始流式输出请求...');
            try {
                const outputResponse = await axios.post(
                    `${PROXY_URL2}/v1/chat/completions`,
                    outputConfig,
                    {
                        headers: {
                            Authorization: `Bearer ${Model_output_API_KEY}`,
                            'Content-Type': 'application/json',
                            'Accept': 'text/event-stream'
                        },
                        responseType: 'stream',
                        timeout: 60000, // 增加超时时间
                        validateStatus: function (status) {
                            return status >= 200 && status < 300;
                        }
                    }
                );

                console.log('输出阶段响应头:', outputResponse.headers);
                
                // 设置SSE响应头，仅在头部未发送时设置
                if (!res.headersSent) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'X-Accel-Buffering': 'no'
                    });
                }

                // 改进的数据处理
                outputResponse.data.on('data', chunk => {
                    try {
                        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                        
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const data = line.slice(6);
                                if (data === '[DONE]') {
                                    res.write('data: [DONE]\n\n');
                                    continue;
                                }
                                
                                try {
                                    const parsed = JSON.parse(data);
                                    const content = parsed.choices[0]?.delta?.content || '';
                                    
                                    if (content) {
                                        // 简化的流式日志
                                        process.stdout.write(content);
                                        
                                        // 根据Show_COT决定是否显示思考内容
                                        let outputContent = content;
                                        
                                        // 只有在之前没有发送过思考内容的情况下才添加
                                        // 由于我们在思考阶段可能已经发送了思考内容，这里需要检查
                                        if (Show_COT === 'true' && !currentTask.thinkingSent) {
                                            // 添加思考内容
                                            outputContent = `<think>${originalThinkingContent}</think>\n\n${content}`;
                                            currentTask.thinkingSent = true;
                                        } else if (Show_COT !== 'true') {
                                            // 如果不显示思考内容，直接使用原始内容
                                            outputContent = content;
                                        }
                                        
                                        const formattedChunk = {
                                            id: `chatcmpl-${Date.now()}`,
                                            object: 'chat.completion.chunk',
                                            created: Math.floor(Date.now() / 1000),
                                            model: HYBRID_MODEL_NAME,
                                            choices: [{
                                                delta: { content: outputContent },
                                                index: 0,
                                                finish_reason: null
                                            }]
                                        };
                                        res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
                                    }
                                } catch (parseError) {
                                    console.error('解析响应失败:', parseError.message);
                                }
                            }
                        }
                    } catch (error) {
                        console.error('处理响应出错:', error.message);
                    }
                });

                // 改进的错误处理
                outputResponse.data.on('error', error => {
                    console.error('输出流错误:', error);
                    if (!res.writableEnded) {
                        res.write(`data: {"error": "Stream error: ${error.message}"}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                    currentTask = null;
                });

                // 改进的结束处理
                outputResponse.data.on('end', () => {
                    console.log('输出流结束');
                    if (!res.writableEnded) {
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                    currentTask = null;
                });

            } catch (error) {
                console.error('流式输出请求失败:', error);
                console.error('错误详情:', {
                    status: error.response?.status,
                    statusText: error.response?.statusText,
                    data: error.response?.data,
                    headers: error.response?.headers
                });
                
                if (!res.headersSent && !res.writableEnded) {
                    res.status(500).json({
                        error: 'Stream request failed',
                        message: error.message,
                        details: error.response?.data
                    });
                } else if (!res.writableEnded) {
                    // 如果头部已发送但响应未结束，以SSE格式发送错误
                    res.write(`data: {"error": "Stream request failed: ${error.message.replace(/"/g, '\\"')}"}

`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
                currentTask = null;
            }
        } else {
            console.log('开始非流式输出请求...');
            const outputResponse = await axios.post(
                `${PROXY_URL2}/v1/chat/completions`,
                outputConfig,
                {
                    headers: {
                        Authorization: `Bearer ${Model_output_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    cancelToken: cancelTokenSource.token,
                    // 添加超时设置
                    timeout: 30000,
                    validateStatus: function (status) {
                        return status >= 200 && status < 300;
                    }
                }
            );

            console.log('输出阶段响应:', JSON.stringify(outputResponse.data, null, 2));
            
            // 处理非流式输出的思考内容显示
            if (Show_COT === 'true') {
                // 如果需要显示思考内容，修改响应
                const modifiedResponse = {
                    ...outputResponse.data,
                    choices: outputResponse.data.choices.map(choice => ({
                        ...choice,
                        message: {
                            ...choice.message,
                            content: `<think>${originalThinkingContent}</think>\n\n${choice.message.content}`
                        }
                    }))
                };
                res.json(modifiedResponse);
            } else {
                // 直接返回原始响应
                res.json(outputResponse.data);
            }
            currentTask = null;
        }

    } catch (error) {
        console.error('请求处理错误:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data
        });
        
        if (!res.headersSent && !res.writableEnded) {
            res.status(500).json({
                error: 'Internal server error',
                message: error.message
            });
        }
        currentTask = null;
    }
});

// 添加健康检查路由
app.get('/health', async (req, res) => {
    try {
        const response = await axios.get(`${PROXY_URL}/health`);
        res.json({ status: 'ok', proxyStatus: response.data });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            message: '代理服务器连接失败',
            error: error.message 
        });
    }
});

// 添加文件处理路由
app.post('/v1/files', apiKeyAuth, async (req, res) => {
    try {
        // 处理文件上传
        // ... 文件处理逻辑
    } catch (error) {
        console.error('文件处理错误:', error.message);
        res.status(500).json({
            error: 'File processing error',
            message: error.message
        });
    }
});

app.listen(PROXY_PORT, () => {
    console.log(`Hybrid AI proxy server started on port ${PROXY_PORT}`);
});