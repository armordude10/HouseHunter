/**
 * Optional Printful File Library mirroring.
 *
 * Runware output URLs are retained ~7 days by default; print files must
 * outlive that. When PRINTFUL_API_KEY is set, every final panel URL is
 * registered into Printful's file library (POST /files, URL-based — Printful
 * fetches and stores the file durably; identical URLs are deduplicated by
 * Printful). The returned file id travels in the panel provenance so order
 * submission can reference stored files instead of ephemeral URLs.
 */

const PRINTFUL_API_BASE = process.env.PRINTFUL_API_BASE ?? "https://api.printful.com";

export interface PrintfulFileRef {
  id: number | string;
  url: string;
}

export const printfulEnabled = () => Boolean(process.env.PRINTFUL_API_KEY);

export const mirrorToPrintfulFileLibrary = async (
  fileUrl: string,
  filename: string
): Promise<PrintfulFileRef | null> => {
  const apiKey = process.env.PRINTFUL_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch(`${PRINTFUL_API_BASE}/files`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ url: fileUrl, filename, visible: true })
    });
    const body = (await response.json().catch(() => null)) as
      | { result?: { id?: number | string } }
      | null;
    if (!response.ok || !body?.result?.id) return null;
    return { id: body.result.id, url: fileUrl };
  } catch {
    // Mirroring is best-effort; the pipeline never fails because of it.
    return null;
  }
};
