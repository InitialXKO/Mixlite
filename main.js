// 基础导入
import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
// 增加JSON请求体的大小限制，以支持可能的大型请求
app.use(express.json({ limit: '20mb' }));

// 从 .env 文件中加载环境变量
const {
  PROXY_PORT,
  PROXY_URL,
  PROXY_URL2,
  Model_think_API_KEY,
  Model_think_MODEL,
  Model_think_MAX_TOKENS,
  Model_think_TEMPERATURE,
  Model_think_WebSearch,
  Model_think_image,
  Think_PROMPT,
  Model_output_API_KEY,
  Model_output_MODEL,
  Model_output_MAX_TOKENS,
  Model_output_TEMPERATURE,
  Model_output_WebSearch,
  Model_output_image,
  Model_output_tool,
  RELAY_PROMPT,
  HYBRID_MODEL_NAME,
  OUTPUT_API_KEY,
  Show_COT,
  LOG_FULL_CONTENT // 用于控制日志详细程度的新环境变量
} = process.env;


// API 密钥验证中间件
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers.authorization;
  if (!apiKey || apiKey !== `Bearer ${OUTPUT_API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized', message: '无效的API密钥' });
  }
  next();
};


// 用于存储当前任务的信息，以实现请求取消功能
let currentTask = null;

// 取消当前正在进行的任务
function cancelCurrentTask() {
  if (!currentTask) return;
  console.log('收到新请求，取消当前任务...');
  try {
    if (currentTask.cancelTokenSource) {
      currentTask.cancelTokenSource.cancel('收到新请求');
    }
    if (currentTask.res && !currentTask.res.writableEnded) {
      // 向被中断的客户端发送一条消息，告知其请求已被新请求覆盖
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

// 过滤图片内容的辅助函数
function filterImageContent(messages, allowImage) {
  if (!allowImage) {
    return messages.map(msg => {
      if (msg.content) {
        if (typeof msg.content === 'string' && msg.content.includes('data:image/')) {
          return {
            ...msg,
            content: msg.content.replace(/data:image\/[^;]+;base64,[^\s"]+/g, '[图片内容已过滤]')
          };
        } else if (typeof msg.content === 'object') {
          // 处理内容为数组的复杂情况 (vision)
          const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
          const filteredParts = parts.map(part => {
            if (part.type === 'image_url' || part.image_url) {
              return { type: 'text', text: '[图片URL已过滤]' };
            }
            return part;
          });
          return {
            ...msg,
            content: Array.isArray(msg.content) ? filteredParts : filteredParts[0]
          };
        }
      }
      return msg;
    });
  }
  return messages;
}

// 处理思考阶段
async function processThinkingStage(messages, stream, res) {
  const filteredMessages = filterImageContent(messages, Model_think_image === 'true');
  const thinkingMessages = [...filteredMessages, { role: "user", content: Think_PROMPT }];
  const thinkingConfig = {
    model: Model_think_MODEL,
    messages: thinkingMessages,
    temperature: parseFloat(Model_think_TEMPERATURE),
    max_tokens: parseInt(Model_think_MAX_TOKENS),
    stream
  };

  // 为特定模型添加特殊配置
  if (Model_think_MODEL === 'gemini-2.5-flash-preview-04-17') {
    thinkingConfig.config = {
      thinkingConfig: { thinkingBudget: 24576 }
    };
  }

  // 如果启用网络搜索，则添加工具定义
  if (Model_think_WebSearch === 'true') {
    thinkingConfig.tools = [{
      type: "function",
      function: {
        name: "googleSearch",
        description: "Search the web for relevant information",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
      }
    }];
  }

  console.log('[INFO] 思考阶段配置:', { model: thinkingConfig.model, temperature: thinkingConfig.temperature, max_tokens: thinkingConfig.max_tokens, stream: thinkingConfig.stream, messageCount: thinkingConfig.messages.length });

  const cancelTokenSource = axios.CancelToken.source();
  let thinkingContent = '';

  try {
    if (stream) {
      const thinkingResponse = await axios.post(
        `${PROXY_URL}/v1/chat/completions`,
        thinkingConfig,
        {
          headers: { Authorization: `Bearer ${Model_think_API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
          responseType: 'stream',
          cancelToken: cancelTokenSource.token,
          timeout: 90000
        }
      );

      const thinkingChunks = [];
      let isFirstThinkingChunk = true;

      if (Show_COT === 'true' && !res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      }

      await new Promise((resolve, reject) => {
        thinkingResponse.data.on('data', chunk => {
          const lines = chunk.toString().split('\n').filter(line => line.trim());
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;
              try {
                  const parsed = JSON.parse(data);
                  const content = parsed.choices[0]?.delta?.content || '';
                  if (content) {
                    thinkingChunks.push(content);
                    if (Show_COT === 'true') {
                      process.stdout.write(content);
                      const outputContent = isFirstThinkingChunk ? `<think>${content}` : content;
                      isFirstThinkingChunk = false;
                      const formattedChunk = {
                        id: `chatcmpl-${Date.now()}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: HYBRID_MODEL_NAME,
                        choices: [{ delta: { content: outputContent }, index: 0, finish_reason: null }]
                      };
                      res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
                    }
                  }
              } catch (parseError) {
                  console.error('思考阶段流数据块解析错误:', parseError.message, '问题数据行:', line);
              }
            }
          }
        });

        thinkingResponse.data.on('error', reject);
        thinkingResponse.data.on('end', () => {
          if (Show_COT === 'true' && !isFirstThinkingChunk) {
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: HYBRID_MODEL_NAME,
              choices: [{ delta: { content: '</think>\n\n' }, index: 0, finish_reason: null }]
            })}\n\n`);
          }
          resolve();
        });
      });

      thinkingContent = thinkingChunks.join('');
      console.log('思考阶段内容收集完成');
      return { content: thinkingContent, thinkingSent: Show_COT === 'true' };
    } else { // 非流式思考
      const thinkingResponse = await axios.post(
        `${PROXY_URL}/v1/chat/completions`,
        thinkingConfig,
        {
          headers: { Authorization: `Bearer ${Model_think_API_KEY}`, 'Content-Type': 'application/json' },
          cancelToken: cancelTokenSource.token,
          timeout: 90000
        }
      );
      thinkingContent = thinkingResponse.data.choices[0].message.content;
      console.log('思考阶段内容收集完成 (非流式)');
      if (LOG_FULL_CONTENT === 'true') {
        console.log('[INFO] 思考模型完整输出 (thinkingContent):\n', thinkingContent || '[无内容]');
      } else {
        console.log(`[INFO] 思考模型输出 (thinkingContent) 长度: ${thinkingContent?.length || 0}`);
        if (thinkingContent?.length > 200) {
          console.log(`[INFO] 思考模型输出 (摘要): ${thinkingContent.substring(0, 100)}...${thinkingContent.substring(thinkingContent.length - 100)}`);
        } else if (thinkingContent) {
          console.log(`[INFO] 思考模型输出: ${thinkingContent}`);
        }
      }
      return { content: thinkingContent, thinkingSent: false };
    }
  } catch (error) {
    console.error('思考阶段 API 调用失败:', {
      message: error.message,
      url: `${PROXY_URL}/v1/chat/completions`,
      request_model: thinkingConfig.model,
      status: error.response?.status,
      data: error.response?.data
    });
    console.log('[INFO] 思考模型阶段因错误返回空内容。');
    return { content: '', thinkingSent: false };
  }
}

// 主请求处理函数
app.post('/v1/chat/completions', apiKeyAuth, async (req, res) => {
  if (currentTask) {
    console.log('存在正在进行的任务，准备取消...');
    cancelCurrentTask();
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log('开始处理新请求...');
  const cancelTokenSource = axios.CancelToken.source();
  currentTask = { res, cancelTokenSource, thinkingSent: false, isMcpFollowUp: false };

  try {
    const originalRequest = req.body;
    const messages = filterImageContent([...originalRequest.messages], Model_output_image === 'true');
    const stream = originalRequest.stream ?? false;
  
    if (originalRequest.model !== HYBRID_MODEL_NAME) {
      throw new Error(`不支持的模型: ${originalRequest.model}`);
    }

    const isMcpFollowUp = messages.some(msg => msg.role === 'tool');
    currentTask.isMcpFollowUp = isMcpFollowUp;

    let thinkingContent = '';
    let thinkingSent = false;

    // 仅在非工具调用后续请求时调用思考模型
    if (!isMcpFollowUp) {
      const thinkingResult = await processThinkingStage(messages, stream, res);
      thinkingContent = thinkingResult.content;
      thinkingSent = thinkingResult.thinkingSent;
      currentTask.thinkingSent = thinkingSent;
    } else {
      console.log('检测到工具调用后续请求，跳过思考模型...');
    }

    // 构建发送给输出模型的消息数组
    // 注意：此原始实现会造成连续两个 user 角色的问题，但已被证明对某些模型（如Grok）是宽容的
    const outputMessages = isMcpFollowUp
      ? messages
      : [
          { role: "system", content: RELAY_PROMPT },
          ...messages,
          ...(thinkingContent ? [{ role: "user", content: thinkingContent }] : [])
        ];

    console.log(`[INFO] 构建的输出模型消息 (outputMessages) 条数: ${outputMessages.length}`);
    outputMessages.forEach((msg, index) => {
      let contentToLog = '';
      if (typeof msg.content === 'string') {
        if (LOG_FULL_CONTENT === 'true' || msg.content.length <= 400) {
            contentToLog = msg.content;
        } else {
            contentToLog = `${msg.content.substring(0,200)}... (长度: ${msg.content.length}) ...${msg.content.substring(msg.content.length-200)}`;
        }
      } else if (Array.isArray(msg.content)) {
        contentToLog = LOG_FULL_CONTENT === 'true' ? JSON.stringify(msg.content) : `[包含多部分内容的对象, 数量: ${msg.content.length}]`;
      } else {
        contentToLog = '[非文本或空内容]';
      }
      console.log(`[INFO] outputMessages[${index}]: role=${msg.role}, content = ${contentToLog}`);
    });

    if (Model_output_tool === 'true') {
      // 当输出模型需要启用工具时
      console.log('[INFO] 工具已启用，直接中转到输出模型...');
      const outputConfig = {
        ...originalRequest,
        messages: outputMessages,
        model: Model_output_MODEL,
        stream
      };
      
      const {messages: _, ...loggableOutputConfig} = outputConfig;
      console.log('[INFO] 输出模型配置 (摘要):', {model: loggableOutputConfig.model, stream: loggableOutputConfig.stream, temperature: loggableOutputConfig.temperature , max_tokens: loggableOutputConfig.max_tokens});

      const outputResponse = await axios.post(
        `${PROXY_URL2}/v1/chat/completions`,
        outputConfig,
        {
          headers: {
            Authorization: `Bearer ${Model_output_API_KEY}`,
            'Content-Type': 'application/json',
            ...(stream ? { 'Accept': 'text/event-stream' } : {})
          },
          responseType: stream ? 'stream' : 'json',
          timeout: 60000,
          cancelToken: cancelTokenSource.token
        }
      );

      if (stream) {
        let accumulatedStreamContent = '';
        if (!res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        }
        
        outputResponse.data.on('data', chunk => {
          // 直接转发上游数据流
          res.write(chunk);
          
          // 如果需要记录日志，则解析数据
          if (LOG_FULL_CONTENT === 'true') {
            const lines = chunk.toString().split('\n').filter(line => line.trim());
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(data);
                            accumulatedStreamContent += parsed.choices[0]?.delta?.content || '';
                        } catch(e){}
                    }
                }
            }
          }
        });

        outputResponse.data.on('end', () => {
          console.log('输出模型流结束');
          if (LOG_FULL_CONTENT === 'true') {
            console.log('[INFO] 输出模型完整流式响应内容 (accumulated):\n', accumulatedStreamContent || '[无累积内容]');
          }
          currentTask = null;
        });

        outputResponse.data.on('error', (error) => {
          console.error('输出模型流错误:', error);
          if (!res.writableEnded) {
            res.end();
          }
          currentTask = null;
        });

      } else { // 非流式，工具启用
        const formattedResponse = {
            ...outputResponse.data,
            model: HYBRID_MODEL_NAME,
        };
        res.json(formattedResponse);
        currentTask = null;
      }
    } else {
      // 当输出模型不需要启用工具时
      const outputConfig = {
        model: Model_output_MODEL,
        messages: outputMessages,
        temperature: parseFloat(Model_output_TEMPERATURE),
        max_tokens: parseInt(Model_output_MAX_TOKENS),
        stream
      };

      if (Model_output_WebSearch === 'true') {
        outputConfig.tools = [{
          type: "function",
          function: { name: "googleSearch", description: "Search the web for relevant information", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }
        }];
      }

      console.log('准备输出阶段配置 (无工具模式):', JSON.stringify(outputConfig, null, 2));

      if (stream) {
        let accumulatedStreamContent_tool_false = '';
        const outputResponse = await axios.post(
          `${PROXY_URL2}/v1/chat/completions`,
          outputConfig,
          {
            headers: { Authorization: `Bearer ${Model_output_API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            responseType: 'stream',
            timeout: 60000,
            cancelToken: cancelTokenSource.token
          }
        );

        if (!res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        }
        
        outputResponse.data.on('data', chunk => {
            const lines = chunk.toString().split('\n').filter(line => line.trim());
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') {
                        res.write('data: [DONE]\n\n');
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices[0]?.delta?.content;
                        
                        if (LOG_FULL_CONTENT === 'true' && content) {
                            accumulatedStreamContent_tool_false += content;
                        }
                        
                        // 替换模型名称后转发
                        const formattedChunk = { ...parsed, model: HYBRID_MODEL_NAME };
                        res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
                        
                        if (content) {
                            process.stdout.write(content);
                        }
                    } catch (parseError) {
                        console.error('输出模型流数据块解析错误 (无工具模式):', parseError.message, '问题数据行:', line);
                    }
                }
            }
        });
        
        outputResponse.data.on('error', (error) => {
            console.error('输出流错误 (无工具模式):', error);
            if (!res.writableEnded) {
                res.end();
            }
            currentTask = null;
        });

        outputResponse.data.on('end', () => {
          console.log('输出流结束 (无工具模式)');
          if (LOG_FULL_CONTENT === 'true') {
            console.log('[INFO] 输出模型完整流式响应内容 (accumulated, tool_false branch):\n', accumulatedStreamContent_tool_false || '[无累积内容]');
          }
          if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          currentTask = null;
        });
      } else { // 非流式，无工具模式
        const axiosResponse = await axios.post(
          `${PROXY_URL2}/v1/chat/completions`,
          outputConfig,
          {
            headers: { Authorization: `Bearer ${Model_output_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 30000,
            cancelToken: cancelTokenSource.token
          }
        );

        const rawResponseData = axiosResponse.data;
        const rawChoice = rawResponseData.choices && rawResponseData.choices[0];
        let finalContent = rawChoice?.message?.content || '';

        if (Show_COT === 'true' && thinkingContent) {
          finalContent = `<think>${thinkingContent}</think>\n\n${finalContent}`;
        }

        const formattedResponse = {
            ...rawResponseData,
            model: HYBRID_MODEL_NAME,
            choices: [{
                ...rawChoice,
                message: {
                    ...rawChoice.message,
                    content: finalContent
                }
            }]
        };
        res.json(formattedResponse);
        currentTask = null;
      }
    }
  } catch (error) {
    console.error('请求处理错误:', {
        message: error.message,
        url: error.config?.url,
        method: error.config?.method,
        status: error.response?.status,
        response_data: error.response?.data
      });
  
    const clientRes = currentTask?.res;
  
    if (clientRes && !clientRes.writableEnded) {
      if (!clientRes.headersSent) {
        clientRes.status(error.response?.status || 500).json({
          error: 'MixLite_Upstream_Error',
          message: `MixLite 处理上游请求时出错: ${error.message}`,
          details: {
            upstream_status: error.response?.status,
            request_url: error.config?.url
          }
        });
      } else {
        const errorPayload = {
          id: `chatcmpl-err-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: req.body?.model || HYBRID_MODEL_NAME,
          choices: [{
            delta: { content: `\n\n[MixLite 服务错误: 上游请求失败。 详情: ${error.message} (状态码: ${error.response?.status || 'N/A'})]` },
            index: 0,
            finish_reason: 'error'
          }]
        };
        try {
          clientRes.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
          clientRes.write('data: [DONE]\n\n');
          clientRes.end();
        } catch (e) {
          console.error("尝试向客户端发送错误流时出错:", e.message);
        }
      }
    }
    currentTask = null;
  }
});

// 健康检查路由
app.get('/health', async (req, res) => {
  try {
    const response = await axios.get(`${PROXY_URL}/health`);
    res.json({ status: 'ok', proxyStatus: response.data });
  } catch (error) {
    res.status(500).json({ status: 'error', message: '代理服务器连接失败', error: error.message });
  }
});

// 文件处理路由 (占位)
app.post('/v1/files', apiKeyAuth, async (req, res) => {
  try {
    res.status(501).json({ error: 'Not Implemented', message: '文件处理功能尚未实现。' });
  } catch (error) {
    console.error('文件处理错误:', error.message);
    res.status(500).json({ error: 'File processing error', message: error.message });
  }
});

app.listen(PROXY_PORT, () => {
  console.log(`混合 AI 代理服务已在端口 ${PROXY_PORT} 上启动`);
});
