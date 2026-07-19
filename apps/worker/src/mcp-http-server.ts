import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import { type VoidbotMcpContext } from "./mcp-server-context";
import { createVoidbotMcpServer } from "./mcp-server-factory";

export interface VoidbotMcpHttpServerOptions {
  host?: string;
  port?: number;
}

export async function startVoidbotMcpHttpServer(
  context: VoidbotMcpContext,
  options: VoidbotMcpHttpServerOptions = {},
): Promise<HttpServer> {
  const host = options.host ?? process.env.VOIDBOT_MCP_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? parsePort(process.env.VOIDBOT_MCP_HTTP_PORT, 17875);
  const app = createMcpExpressApp({ host });

  app.post("/mcp", async (
    request: IncomingMessage & { body?: unknown },
    response: ServerResponse,
  ) => {
    const server = createVoidbotMcpServer(context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("VoidBot MCP HTTP request failed:", error);
      if (!response.headersSent) {
        sendJson(response, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP error" },
          id: null,
        });
      }
    } finally {
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  });

  app.get("/mcp", (_request: IncomingMessage, response: ServerResponse) => {
    sendJson(response, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });
  app.delete("/mcp", (_request: IncomingMessage, response: ServerResponse) => {
    sendJson(response, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });

  return await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(port, host, () => {
      console.log(`VoidBot resident MCP listening at http://${host}:${port}/mcp.`);
      resolve(listener);
    });
    listener.once("error", reject);
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`VOIDBOT_MCP_HTTP_PORT must be a valid TCP port; received ${raw}.`);
  }
  return parsed;
}
