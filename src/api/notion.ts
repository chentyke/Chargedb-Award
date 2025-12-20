import type { NotionResponse } from "../types/notion";

const baseUrl = import.meta.env.VITE_API_BASE ?? "";

export async function fetchNotionItems(): Promise<NotionResponse> {
  const response = await fetch(`${baseUrl}/api/notion`);

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to fetch Notion data.");
  }

  return response.json();
}

export type VoteSubmission = {
  id: string;
  count: number;
  category?: string;
  title?: string;
  brand?: string;
  model?: string;
  reason?: string;
};

export type VotePayload = {
  votes: VoteSubmission[];
  keyId?: string;
  results?: unknown;
};

export async function submitVotes(
  payload: VotePayload,
): Promise<{
  ok: boolean;
  updated?: number;
  message?: string;
  resultsSaved?: boolean;
}> {
  const response = await fetch(`${baseUrl}/api/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to submit votes.");
  }

  return response.json();
}

export async function verifyVoteKey(
  key: string,
): Promise<{ ok: boolean; keyId: string; message?: string }> {
  const response = await fetch(`${baseUrl}/api/vote-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to verify vote key.");
  }

  return response.json();
}
