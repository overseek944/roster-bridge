/**
 * OneRoster consumer.
 *
 * Two properties matter more than completeness here. It is resumable, because a
 * large district takes long enough that "just run it again" costs you the
 * window. And it distinguishes an empty successful response from a failure,
 * because the most common production failure in this domain raises no
 * exception at all.
 */

export interface SourceConfig {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  version: "v1p1" | "v1p2";
}

export const COLLECTIONS = [
  "orgs",
  "academicSessions",
  "courses",
  "classes",
  "users",
  "enrollments",
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

/**
 * Ingest order. References must resolve to rows that already exist; anything
 * else means creating placeholder records, and placeholders with no name live
 * forever.
 */
export const INGEST_ORDER: CollectionName[] = [
  "orgs",
  "academicSessions",
  "courses",
  "classes",
  "users",
  "enrollments",
];

export class SourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly collection: CollectionName | null,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export class OneRosterClient {
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(private readonly config: SourceConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry - 30_000) return this.token;

    const credentials = btoa(`${this.config.clientId}:${this.config.clientSecret}`);
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) {
      throw new SourceError(
        `token endpoint returned ${response.status}`,
        response.status,
        null,
      );
    }
    const body = (await response.json()) as { access_token: string; expires_in?: number };
    this.token = body.access_token;
    this.tokenExpiry = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.token;
  }

  /**
   * Fetches one page. Returning the page rather than looping internally is what
   * makes the whole run resumable: the caller stores the offset and can stop
   * between pages without losing work.
   */
  async page(
    collection: CollectionName,
    offset: number,
    limit: number,
    since?: string | null,
  ): Promise<{ rows: Record<string, unknown>[]; total: number | null }> {
    const url = new URL(`${this.config.baseUrl}/ims/oneroster/${this.config.version}/${collection}`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    // Sorting by a stable key so pages do not overlap or skip if the provider
    // is written to mid-pagination.
    url.searchParams.set("sort", "sourcedId");
    if (since) url.searchParams.set("filter", `dateLastModified>'${since}'`);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });

    if (!response.ok) {
      throw new SourceError(
        `${collection} returned ${response.status}`,
        response.status,
        collection,
      );
    }

    const body = (await response.json()) as Record<string, unknown>;
    // The response key follows the collection, not the route: /schools returns
    // {"orgs": [...]}. Falling back to the first array present tolerates a
    // provider that names it differently.
    const rows =
      (body[collection] as Record<string, unknown>[] | undefined) ??
      (Object.values(body).find(Array.isArray) as Record<string, unknown>[] | undefined) ??
      [];

    const totalHeader = response.headers.get("x-total-count");
    return {
      rows,
      total: totalHeader === null ? null : Number(totalHeader),
    };
  }
}
