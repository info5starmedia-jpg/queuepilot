import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { GoogleAuthService } from "./google-auth.service.js";

/**
 * Sheets read client. Read-only by contract (the OAuth scope is
 * spreadsheets.readonly); values come back as string[][] — exactly what the
 * provider row-parsers (parseProfileRows / parseProxyRows) consume.
 */

/** What provider services actually need — mockable without Google. */
export interface SheetReader {
  getValues(sheetId: string, range: string): Promise<string[][]>;
}

export class SheetsClient implements SheetReader {
  constructor(
    private readonly auth: GoogleAuthService,
    private readonly baseUrl: string = "https://sheets.googleapis.com",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getValues(sheetId: string, range: string): Promise<string[][]> {
    const token = await this.auth.getAccessToken();
    const url = `${this.baseUrl}/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
    const res = await this.fetcher(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new DomainError(
        ErrorCodes.PROVIDER_SOURCE_UNREADABLE,
        `google sheets read failed for ${sheetId} (${range}): HTTP ${res.status}`,
      );
    }
    const data = (await res.json()) as { values?: string[][] };
    return data.values ?? [];
  }
}
