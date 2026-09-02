type OpenAIResponseContent = {
  type?: string;
  text?: string;
};

type OpenAIResponseItem = {
  type?: string;
  role?: string;
  content?: OpenAIResponseContent[];
};

type OpenAIResponsePayload = {
  id?: string;
  output_text?: string;
  output?: OpenAIResponseItem[];
};

export type OpenAIResponsesRequest = {
  model: string;
  instructions: string;
  input: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  temperature?: number;
  maxOutputTokens?: number;
};

export type OpenAIResponsesResult = {
  id?: string;
  text: string;
};

function extractOutputText(data: OpenAIResponsePayload): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const chunks: string[] = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.trim()) {
        chunks.push(content.text.trim());
      }
    }
  }
  return chunks.join("\n").trim();
}

export async function callOpenAIResponses(
  request: OpenAIResponsesRequest
): Promise<OpenAIResponsesResult> {
  const apiKey = process.env.OPENAI_API_KEY || "";
  const baseUrl = (process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const body: Record<string, unknown> = {
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    max_output_tokens: request.maxOutputTokens ?? 1800,
  };

  if (typeof request.temperature === "number") {
    body.temperature = request.temperature;
  }

  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Responses API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as OpenAIResponsePayload;
  const text = extractOutputText(data);
  if (!text) {
    throw new Error("OpenAI Responses API returned no output text");
  }

  return { id: data.id, text };
}
