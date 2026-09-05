import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAgentKnowledgeBase,
  createKnowledgeDocumentFromFile,
  createKnowledgeDocumentFromUrl,
  deleteKnowledgeDocument,
  getKnowledgeDocumentStatus,
  mergeKnowledgeBase,
} from "@/lib/elevenlabs/knowledge-base";
import {
  isKnowledgeFilePath,
  KNOWLEDGE_FILE_ACCEPT,
  KNOWLEDGE_FILE_MAX_BYTES,
  knowledgeSourceName,
  sourceSyncState,
  validateKnowledgeFile,
} from "@/lib/knowledge-bases/rules";

/**
 * Knowledge bases ↔ ElevenLabs.
 *
 * THE GAP THIS GUARDS: until this feature nothing uploaded a knowledge-base
 * source to ElevenLabs or attached it to an agent, so an agent with a
 * knowledge base "attached" in the wizard drew on nothing. These tests pin
 * (1) the agent payload built from synced sources, (2) the merge into a
 * connected agent's existing list, (3) the truthful sync state shown in the
 * dialog, (4) the file rules, and (5) the exact ElevenLabs endpoints and
 * request shapes, with fetch stubbed — no network.
 */

const KB_API = "https://api.elevenlabs.io/v1/convai/knowledge-base";
const KB_ID = "11111111-1111-4111-8111-111111111111";

const OLD_LIVE = process.env.ELEVENLABS_LIVE;
const OLD_KEY = process.env.ELEVENLABS_API_KEY;

afterEach(() => {
  process.env.ELEVENLABS_LIVE = OLD_LIVE;
  process.env.ELEVENLABS_API_KEY = OLD_KEY;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Agent payload
// ---------------------------------------------------------------------------

describe("buildAgentKnowledgeBase", () => {
  it("maps synced sources to { type, id, name, usage_mode: auto }", () => {
    const out = buildAgentKnowledgeBase([
      {
        type: "file",
        file_path: `${KB_ID}/abc/pricing.pdf`,
        url: null,
        elevenlabs_document_id: "doc_file_1",
      },
      {
        type: "url",
        file_path: null,
        url: "https://example.com/faq",
        elevenlabs_document_id: "doc_url_1",
      },
    ]);
    expect(out).toEqual([
      {
        type: "file",
        id: "doc_file_1",
        name: "pricing.pdf",
        usage_mode: "auto",
      },
      {
        type: "url",
        id: "doc_url_1",
        name: "https://example.com/faq",
        usage_mode: "auto",
      },
    ]);
  });

  it("leaves out sources that never reached ElevenLabs", () => {
    const out = buildAgentKnowledgeBase([
      {
        type: "url",
        file_path: null,
        url: "https://example.com/a",
        elevenlabs_document_id: null,
      },
      {
        type: "url",
        file_path: null,
        url: "https://example.com/b",
        elevenlabs_document_id: "doc_b",
      },
    ]);
    expect(out.map((e) => e.id)).toEqual(["doc_b"]);
  });

  it("collapses the same document reached via two knowledge bases", () => {
    const row = {
      type: "url",
      file_path: null,
      url: "https://example.com/shared",
      elevenlabs_document_id: "doc_shared",
    };
    expect(buildAgentKnowledgeBase([row, { ...row }])).toHaveLength(1);
  });

  it("returns an empty list for no sources (clears stale docs on update)", () => {
    expect(buildAgentKnowledgeBase([])).toEqual([]);
  });
});

describe("mergeKnowledgeBase (connected agents)", () => {
  const ours = [
    {
      type: "url" as const,
      id: "doc_ours",
      name: "ours",
      usage_mode: "auto" as const,
    },
  ];

  it("keeps entries the user attached in the ElevenLabs dashboard", () => {
    const existing = [
      { type: "text", id: "doc_theirs", name: "Theirs", usage_mode: "prompt" },
    ];
    expect(mergeKnowledgeBase(existing, ours, new Set(["doc_ours"]))).toEqual([
      existing[0],
      ours[0],
    ]);
  });

  it("drops stale entries that point at documents we manage", () => {
    const existing = [
      { type: "url", id: "doc_removed", name: "old", usage_mode: "auto" },
      { type: "url", id: "doc_ours", name: "ours", usage_mode: "auto" },
    ];
    const merged = mergeKnowledgeBase(
      existing,
      ours,
      new Set(["doc_removed", "doc_ours"]),
    );
    expect(merged.map((e) => (e as { id: string }).id)).toEqual(["doc_ours"]);
  });

  it("tolerates a missing or malformed existing list", () => {
    expect(mergeKnowledgeBase(undefined, ours, new Set())).toEqual(ours);
    expect(mergeKnowledgeBase("nope", ours, new Set())).toEqual(ours);
    expect(mergeKnowledgeBase([null, 3], ours, new Set())).toEqual(ours);
  });
});

// ---------------------------------------------------------------------------
// Sync state + naming
// ---------------------------------------------------------------------------

describe("sourceSyncState", () => {
  it("is synced when ElevenLabs holds a document id", () => {
    expect(
      sourceSyncState({ elevenlabs_document_id: "doc_1", sync_error: null }),
    ).toBe("synced");
  });

  it("is error when the last upload failed and nothing is stored", () => {
    expect(
      sourceSyncState({ elevenlabs_document_id: null, sync_error: "boom" }),
    ).toBe("error");
  });

  it("is pending when never tried (rows from before sync existed)", () => {
    expect(
      sourceSyncState({ elevenlabs_document_id: null, sync_error: null }),
    ).toBe("pending");
  });

  it("a stored document wins over a stale error message", () => {
    expect(
      sourceSyncState({ elevenlabs_document_id: "doc_1", sync_error: "old" }),
    ).toBe("synced");
  });
});

describe("knowledgeSourceName", () => {
  it("uses the URL for url sources and the file name for files", () => {
    expect(
      knowledgeSourceName({
        type: "url",
        url: "https://x.y/z",
        file_path: null,
      }),
    ).toBe("https://x.y/z");
    expect(
      knowledgeSourceName({
        type: "file",
        url: null,
        file_path: `${KB_ID}/uuid/Playbook v2.docx`,
      }),
    ).toBe("Playbook v2.docx");
  });
});

// ---------------------------------------------------------------------------
// File rules
// ---------------------------------------------------------------------------

describe("validateKnowledgeFile", () => {
  it.each(["a.pdf", "b.txt", "c.md", "d.docx", "e.html", "f.htm", "G.PDF"])(
    "accepts %s",
    (name) => {
      expect(validateKnowledgeFile({ name, size: 1024 })).toBeNull();
    },
  );

  it.each(["setup.exe", "notes", "sheet.xlsx", "clip.mp3", ".pdf.zip"])(
    "rejects %s",
    (name) => {
      expect(validateKnowledgeFile({ name, size: 1024 })).toMatch(
        /file type isn't supported/,
      );
    },
  );

  it("rejects files over 10 MB and accepts exactly 10 MB", () => {
    expect(
      validateKnowledgeFile({
        name: "big.pdf",
        size: KNOWLEDGE_FILE_MAX_BYTES + 1,
      }),
    ).toMatch(/too big/);
    expect(
      validateKnowledgeFile({ name: "ok.pdf", size: KNOWLEDGE_FILE_MAX_BYTES }),
    ).toBeNull();
  });

  it("exposes the accept list the file input uses", () => {
    expect(KNOWLEDGE_FILE_ACCEPT).toBe(".pdf,.txt,.md,.docx,.html,.htm");
  });
});

describe("isKnowledgeFilePath", () => {
  it("accepts <kbId>/<uuid>/<file> with an allowed extension", () => {
    expect(isKnowledgeFilePath(KB_ID, `${KB_ID}/u1/pricing.pdf`)).toBe(true);
  });

  it("rejects a path under a different knowledge base", () => {
    expect(isKnowledgeFilePath(KB_ID, `other-kb/u1/pricing.pdf`)).toBe(false);
    // Prefix must be the whole first segment, not a string prefix.
    expect(isKnowledgeFilePath(KB_ID, `${KB_ID}x/u1/pricing.pdf`)).toBe(false);
  });

  it("rejects traversal, empty segments and shallow paths", () => {
    expect(isKnowledgeFilePath(KB_ID, `${KB_ID}/../x/pricing.pdf`)).toBe(false);
    expect(isKnowledgeFilePath(KB_ID, `${KB_ID}//pricing.pdf`)).toBe(false);
    expect(isKnowledgeFilePath(KB_ID, `${KB_ID}/pricing.pdf`)).toBe(false);
  });

  it("rejects a disallowed extension even under the right folder", () => {
    expect(isKnowledgeFilePath(KB_ID, `${KB_ID}/u1/malware.exe`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ElevenLabs client — endpoints and request shapes (fetch stubbed)
// ---------------------------------------------------------------------------

describe("ElevenLabs knowledge-base client (mock mode)", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_LIVE = "mock";
  });

  it("never touches the network and returns a mock document id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const url = await createKnowledgeDocumentFromUrl("https://x.y", "x");
    const file = await createKnowledgeDocumentFromFile(
      { blob: new Blob(["hi"]), filename: "a.txt" },
      "a.txt",
    );
    expect(url.documentId).toMatch(/^kbdoc_mock_/);
    expect(file.documentId).toMatch(/^kbdoc_mock_/);
    expect(await deleteKnowledgeDocument("kbdoc_mock_x")).toEqual({
      error: null,
    });
    expect(await getKnowledgeDocumentStatus("kbdoc_mock_x")).toEqual({
      state: "present",
      sizeBytes: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ElevenLabs knowledge-base client (live mode)", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_LIVE = "live";
    process.env.ELEVENLABS_API_KEY = "test-key";
  });

  it("POSTs a URL source as JSON to /knowledge-base/url", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "doc_url_123", name: "FAQ" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await createKnowledgeDocumentFromUrl(
      "https://example.com/faq",
      "https://example.com/faq",
    );
    expect(r).toEqual({ documentId: "doc_url_123", error: null });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${KB_API}/url`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(
      "test-key",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      url: "https://example.com/faq",
      name: "https://example.com/faq",
    });
  });

  it("POSTs a file as multipart/form-data to /knowledge-base/file", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "doc_file_456", name: "pricing.pdf" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await createKnowledgeDocumentFromFile(
      { blob: new Blob(["%PDF-1.4"]), filename: "pricing.pdf" },
      "pricing.pdf",
    );
    expect(r).toEqual({ documentId: "doc_file_456", error: null });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${KB_API}/file`);
    expect(init.method).toBe("POST");
    // fetch must set the multipart boundary itself.
    expect(init.headers).not.toHaveProperty("Content-Type");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.name).toBe("pricing.pdf");
    expect(await file.text()).toBe("%PDF-1.4");
    expect(form.get("name")).toBe("pricing.pdf");
  });

  it("surfaces the status and detail of a rejected upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () =>
          JSON.stringify({ detail: { message: "Unsupported file type" } }),
      }),
    );
    const r = await createKnowledgeDocumentFromUrl("https://x.y", "x");
    expect(r.documentId).toBeNull();
    expect(r.error).toBe(
      "ElevenLabs URL upload failed (422): Unsupported file type",
    );
  });

  it("fails cleanly without an API key", async () => {
    process.env.ELEVENLABS_API_KEY = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await createKnowledgeDocumentFromUrl("https://x.y", "x");
    expect(r).toEqual({
      documentId: null,
      error: "ElevenLabs API key isn't set.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DELETEs with force=true and treats 404 as already gone", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "boom",
      });
    vi.stubGlobal("fetch", fetchMock);

    expect(await deleteKnowledgeDocument("doc a")).toEqual({ error: null });
    expect(await deleteKnowledgeDocument("doc_b")).toEqual({ error: null });
    expect(await deleteKnowledgeDocument("doc_c")).toEqual({
      error: "ElevenLabs document delete failed (500): boom",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${KB_API}/doc%20a?force=true`);
    expect(init.method).toBe("DELETE");
  });

  it("reports a document as present / missing / unknown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "doc_1", metadata: { size_bytes: 1234 } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "",
      });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getKnowledgeDocumentStatus("doc_1")).toEqual({
      state: "present",
      sizeBytes: 1234,
    });
    expect(await getKnowledgeDocumentStatus("doc_2")).toEqual({
      state: "missing",
    });
    expect(await getKnowledgeDocumentStatus("doc_3")).toEqual({
      state: "unknown",
      error: "ElevenLabs document lookup failed (503).",
    });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`${KB_API}/doc_1`);
  });
});
