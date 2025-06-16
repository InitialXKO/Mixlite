// 基础导入
import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

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
  Show_COT
} = process.env;


// API 密钥验证中间件
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers.authorization;
  if (!apiKey || apiKey !== `Bearer ${OUTPUT_API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
  }
  next();
};


// 用于存储当前任务的信息，新增 MCP 状态
let currentTask = null;

// 取消当前任务
function cancelCurrentTask() {
  if (!currentTask) return;
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
          // 处理结构化数据中的image_url
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
  // 根据Model_think_image配置过滤图片内容
  const filteredMessages = filterImageContent(messages, Model_think_image === 'true');
  const thinkingMessages = [...filteredMessages, { role: "user", content: Think_PROMPT }];
  const thinkingConfig = {
    model: Model_think_MODEL,
    messages: thinkingMessages,
    temperature: parseFloat(Model_think_TEMPERATURE),
    max_tokens: parseInt(Model_think_MAX_TOKENS),
    stream
  };

  // Conditionally add config for specific models
  if (Model_think_MODEL === 'gemini-2.5-flash-preview-04-17') {
    thinkingConfig.config = {
      thinkingConfig: { thinkingBudget: 24576 } // Correct structure: config -> thinkingConfig
    };
  }

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

  console.log('思考阶段配置:', { model: thinkingConfig.model, temperature: thinkingConfig.temperature, messageCount: thinkingConfig.messages.length });

  const cancelTokenSource = axios.CancelToken.source();
  let thinkingContent = '';

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
  } else {
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
    return { content: thinkingContent, thinkingSent: false };
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
    // 根据Model_output_image配置过滤图片内容
    const messages = filterImageContent([...originalRequest.messages], Model_output_image === 'true');
    const stream = originalRequest.stream ?? true;

    if (originalRequest.model !== HYBRID_MODEL_NAME) {
      throw new Error(`不支持的模型: ${originalRequest.model}`);
    }

    // 判断是否为 MCP 后续请求（基于是否有工具调用返回）
    const isMcpFollowUp = messages.some(msg => msg.role === 'tool');
    currentTask.isMcpFollowUp = isMcpFollowUp;

    let thinkingContent = '';
    let thinkingSent = false;

    // 仅在非 MCP 后续请求（即用户首次输入）时调用思考模型
    if (Model_output_tool === 'true' && !isMcpFollowUp) {
      const thinkingResult = await processThinkingStage(messages, stream, res);
      thinkingContent = thinkingResult.content;
      thinkingSent = thinkingResult.thinkingSent;
      currentTask.thinkingSent = thinkingSent;
    } else if (!isMcpFollowUp) {
      // tool=false 时，无论如何都调用思考模型
      const thinkingResult = await processThinkingStage(messages, stream, res);
      thinkingContent = thinkingResult.content;
      thinkingSent = thinkingResult.thinkingSent;
      currentTask.thinkingSent = thinkingSent;
    } else {
      console.log('检测到 MCP 后续请求，跳过思考模型...');
    }

    // 构建输出消息
    const outputMessages = isMcpFollowUp
      ? messages // MCP 后续请求直接使用客户端传入的消息
      : [
          { role: "system", content: RELAY_PROMPT },
          ...messages.slice(0, -1),
          messages[messages.length - 1],
          ...(thinkingContent ? [{ role: "user", content: thinkingContent }] : [])
        ];

    if (Model_output_tool === 'true') {
      // 工具启用时，直接中转到输出模型
      console.log('工具启用，直接中转到输出模型...');
      const outputConfig = {
        ...originalRequest,
        messages: outputMessages,
        model: Model_output_MODEL,
        stream
      };

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
          timeout: 60000
        }
      );

      if (stream) {
        if (!res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        }
        // outputResponse.data.pipe(res); // 修改：不再直接pipe
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
                // 假设原始chunk已经是OpenAI兼容格式，如果不是，需要在这里构造
                // 为了通用性，我们重新构造它，确保字段正确
                const choice = parsed.choices && parsed.choices[0];
                const delta = choice && choice.delta;
                const content = delta && delta.content;
                const finish_reason = choice && choice.finish_reason;

                const formattedChunk = {
                  id: parsed.id || `chatcmpl-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: parsed.created || Math.floor(Date.now() / 1000),
                  model: HYBRID_MODEL_NAME, // 使用混合模型名称
                  choices: [{
                    delta: content ? { content } : {},
                    index: 0,
                    finish_reason: finish_reason || null
                  }]
                };
                res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
              } catch (e) {
                // 如果原始数据不是JSON，或者格式不对，尝试直接透传内容，或者记录错误
                // console.warn('MCP stream chunk parsing error or not OpenAI format, attempting passthrough for content:', line);
                // Fallback: if it's not a parsable JSON, but contains content, wrap it.
                // This part might need adjustment based on actual PROXY_URL2 stream format.
                // For now, if it's not OpenAI like, we'll assume it's raw content for simplicity.
                // A more robust solution would check the actual format of PROXY_URL2's stream.
                if (!line.includes('[DONE]') && !line.includes('error')) {
                   const fallbackChunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: HYBRID_MODEL_NAME,
                    choices: [{ delta: { content: line.replace(/^data: /, '') }, index: 0, finish_reason: null }]
                  };
                  // res.write(`data: ${JSON.stringify(fallbackChunk)}\n\n`);
                  // More safely, if we can't parse it as OpenAI, we should indicate an error or adapt.
                  // For now, let's assume PROXY_URL2 sends OpenAI compatible chunks. If not, this needs rework.
                  console.error('MCP stream chunk is not in expected OpenAI format and could not be parsed:', line);
                  // To avoid breaking client, send an error chunk or handle gracefully
                  // For now, we will assume valid OpenAI chunks from the upstream.
                } else if (line.includes('[DONE]')) {
                    res.write('data: [DONE]\n\n');
                }
              }
            }
          }
        });
        outputResponse.data.on('end', () => {
          console.log('MCP 输出流结束');
          if (!res.writableEnded) {
             // Ensure [DONE] is sent if not already sent by a chunk
            // res.write('data: [DONE]\n\n'); // This might be redundant if last chunk sends it
            // res.end(); // End is handled by the main try/catch or if stream ends properly
          }
          // 不重置 currentTask，等待新用户请求
        });
        outputResponse.data.on('error', (error) => {
          console.error('MCP 输出流错误:', error);
          if (!res.writableEnded) {
            const errorPayload = {
              id: `chatcmpl-err-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: HYBRID_MODEL_NAME,
              choices: [{ delta: { content: `\n\n[Stream Error: ${error.message}]` }, index: 0, finish_reason: 'error' }]
            };
            res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
          currentTask = null;
        });
      } else { // Non-stream when Model_output_tool === 'true'
        const rawResponseData = outputResponse.data;
        const choice = rawResponseData.choices && rawResponseData.choices[0];
        const message = choice && choice.message;
        const content = message && message.content;
        const finish_reason = choice && choice.finish_reason;

        const formattedResponse = {
          id: rawResponseData.id || `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: rawResponseData.created || Math.floor(Date.now() / 1000),
          model: HYBRID_MODEL_NAME, // Use the hybrid model name
          choices: [{
            message: {
              role: 'assistant',
              content: content || ''
            },
            index: 0,
            finish_reason: finish_reason || 'stop' // Default to stop if not provided
          }],
          usage: rawResponseData.usage // Preserve usage statistics if available
        };
        res.json(formattedResponse);
        currentTask = null;
      }
    } else {
      // 工具未启用时，保留原有逻辑
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
          function: {
            name: "googleSearch",
            description: "Search the web for relevant information",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
          }
        }];
      }

      console.log('准备输出阶段配置:', JSON.stringify(outputConfig, null, 2));

      if (stream) {
        const outputResponse = await axios.post(
          `${PROXY_URL2}/v1/chat/completions`,
          outputConfig,
          {
            headers: { Authorization: `Bearer ${Model_output_API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            responseType: 'stream',
            timeout: 60000
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
              const parsed = JSON.parse(data);
              const choice = parsed.choices && parsed.choices[0];
              const delta = choice && choice.delta;
              const content = delta && delta.content;
              const finish_reason = choice && choice.finish_reason; // Extract finish_reason

              // Send chunk if there's content OR if it's the final chunk with a finish_reason
              if (content || finish_reason) {
                if (content) { // Only write to stdout if there is actual content
                    process.stdout.write(content);
                }
                
                let outputContent = content || ''; // Ensure outputContent is at least an empty string if content is null/undefined but there's a finish_reason
                if (Show_COT === 'true' && !currentTask.thinkingSent && thinkingContent) {
                    // Prepend thinkingContent only if it exists and hasn't been sent
                    if (content || finish_reason) { // Ensure we only send think content once, with the first actual data or finish signal
                        outputContent = `<think>${thinkingContent}</think>\n\n${outputContent}`;
                        currentTask.thinkingSent = true;
                    }
                }

                const formattedChunk = {
                  id: parsed.id || `chatcmpl-${Date.now()}`, // Use id from original chunk if available
                  object: 'chat.completion.chunk',
                  created: parsed.created || Math.floor(Date.now() / 1000), // Use created from original chunk
                  model: HYBRID_MODEL_NAME,
                  choices: [{
                    delta: content ? { content: outputContent } : {}, // Send delta only if content exists, otherwise empty delta for finish_reason
                    index: 0,
                    finish_reason: finish_reason || null
                  }]
                };
                res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
              }
            }
          }
        });

        outputResponse.data.on('error', (error) => {
          console.error('输出流错误:', error);
          if (!res.writableEnded) {
            res.write(`data: {"error": "Stream error: ${error.message}"}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
          currentTask = null;
        });

        outputResponse.data.on('end', () => {
          console.log('输出流结束');
          if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          currentTask = null;
        });
      } else { // Non-stream when Model_output_tool === 'false'
        const axiosResponse = await axios.post(
          `${PROXY_URL2}/v1/chat/completions`,
          outputConfig,
          {
            headers: { Authorization: `Bearer ${Model_output_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 30000
          }
        );

        const rawResponseData = axiosResponse.data;
        const rawChoice = rawResponseData.choices && rawResponseData.choices[0];
        let finalContent = rawChoice && rawChoice.message && rawChoice.message.content || '';

        if (Show_COT === 'true' && thinkingContent) {
          finalContent = `<think>${thinkingContent}</think>\n\n${finalContent}`;
        }

        const formattedResponse = {
          id: rawResponseData.id || `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: rawResponseData.created || Math.floor(Date.now() / 1000),
          model: HYBRID_MODEL_NAME, // Ensure consistent model name
          choices: [{
            message: {
              role: 'assistant',
              content: finalContent
            },
            index: 0,
            finish_reason: rawChoice && rawChoice.finish_reason || 'stop'
          }],
          usage: rawResponseData.usage // Preserve usage statistics if available
        };
        res.json(formattedResponse);
        currentTask = null;
      }
    }
  } catch (error) {
    console.error('请求处理错误:', { message: error.message, status: error.response?.status, data: error.response?.data });
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({ error: 'Internal server error', message: error.message });
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

// 文件处理路由
app.post('/v1/files', apiKeyAuth, async (req, res) => {
  try {
    // 文件处理逻辑（待实现）
    res.json({ status: 'ok', message: '文件处理成功' });
  } catch (error) {
    console.error('文件处理错误:', error.message);
    res.status(500).json({ error: 'File processing error', message: error.message });
  }
});

app.listen(PROXY_PORT, () => {
  console.log(`Hybrid AI proxy server started on port ${PROXY_PORT}`);
});