export interface ArtifactAttachment {
  original_name: 'change-ticket.md' | 'dependency-map.svg' | 'evidence-bundle.zip';
  mime: 'text/markdown' | 'image/svg+xml' | 'application/zip';
  sha256: string;
  bytes: number;
  handle: string;
  download_url: string;
}

export interface ApprovalReview {
  approval_id: string;
  description_untrusted: string;
  payload: Record<string, unknown>;
  payload_sha256: string;
  target: string;
  credential_identity: string;
  expires_at: string;
  canonical_payload: string;
}

const ATTACHMENT_IDENTITIES = {
  'change-ticket.md': {
    mime: 'text/markdown',
    handleEntry: 'change-ticket.md',
  },
  'dependency-map.svg': {
    mime: 'image/svg+xml',
    handleEntry: 'dependency-map.svg',
  },
  'evidence-bundle.zip': {
    mime: 'application/zip',
    handleEntry: 'bundle.zip',
  },
} as const;

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SHA256_PATTERN = '[a-f0-9]{64}';
const ARTIFACT_HANDLE_RE = new RegExp(
  `^artifact://project/(${UUID_PATTERN})/bundle/(${SHA256_PATTERN})$`,
);
const SIDECAR_HANDLE_RE = new RegExp(
  `^deliverable://project/(${UUID_PATTERN})/bundle/(${SHA256_PATTERN})/(change-ticket\\.md|dependency-map\\.svg)$`,
);

interface ParsedPublicHandle {
  projectId: string;
  bundleSha256: string;
  entry: 'bundle.zip' | 'change-ticket.md' | 'dependency-map.svg';
}

function parsePublicHandle(value: unknown): ParsedPublicHandle | null {
  if (typeof value !== 'string' || value.includes('%') || value.includes('..') || value.includes('\\')) {
    return null;
  }
  const artifact = ARTIFACT_HANDLE_RE.exec(value);
  if (artifact) {
    return { projectId: artifact[1]!, bundleSha256: artifact[2]!, entry: 'bundle.zip' };
  }
  const sidecar = SIDECAR_HANDLE_RE.exec(value);
  if (!sidecar) return null;
  return {
    projectId: sidecar[1]!,
    bundleSha256: sidecar[2]!,
    entry: sidecar[3] as 'change-ticket.md' | 'dependency-map.svg',
  };
}

export function parseArtifactAttachments(value: unknown): ArtifactAttachment[] {
  if (!Array.isArray(value) || value.length !== 3) return [];
  const parsed: Array<{ attachment: ArtifactAttachment; handle: ParsedPublicHandle }> = [];
  const observedNames = new Set<string>();

  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.original_name !== 'string' ||
      !Object.prototype.hasOwnProperty.call(ATTACHMENT_IDENTITIES, item.original_name)
    ) {
      return [];
    }
    const originalName = item.original_name as keyof typeof ATTACHMENT_IDENTITIES;
    const expected = ATTACHMENT_IDENTITIES[originalName];
    const handle = parsePublicHandle(item.handle);
    if (
      observedNames.has(originalName) ||
      item.mime !== expected.mime ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      (item.bytes as number) <= 0 ||
      (item.bytes as number) > 5 * 1024 * 1024 ||
      handle === null ||
      handle.entry !== expected.handleEntry ||
      typeof item.download_url !== 'string' ||
      !/^\/api\/artifacts\/[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}$/.test(item.download_url)
    ) {
      return [];
    }
    observedNames.add(originalName);
    parsed.push({ attachment: item as unknown as ArtifactAttachment, handle });
  }

  if (observedNames.size !== 3) return [];
  const identity = parsed[0]!.handle;
  if (
    parsed.some(
      ({ handle }) => handle.projectId !== identity.projectId || handle.bundleSha256 !== identity.bundleSha256,
    )
  ) {
    return [];
  }
  return parsed.map(({ attachment }) => attachment);
}

export function parseApprovalReview(value: unknown): ApprovalReview | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const payload = item.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  if (
    typeof item.approval_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.approval_id) ||
    typeof item.description_untrusted !== 'string' ||
    item.description_untrusted.length < 1 ||
    item.description_untrusted.length > 2_000 ||
    typeof item.payload_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.payload_sha256) ||
    typeof item.target !== 'string' ||
    item.target.length < 1 ||
    item.target.length > 1_024 ||
    typeof item.credential_identity !== 'string' ||
    item.credential_identity.length < 1 ||
    item.credential_identity.length > 512 ||
    typeof item.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(item.expires_at)) ||
    typeof item.canonical_payload !== 'string' ||
    item.canonical_payload.length < 2 ||
    item.canonical_payload.length > 262_144
  ) {
    return null;
  }
  return {
    approval_id: item.approval_id,
    description_untrusted: item.description_untrusted,
    payload: payload as Record<string, unknown>,
    payload_sha256: item.payload_sha256,
    target: item.target,
    credential_identity: item.credential_identity,
    expires_at: item.expires_at,
    canonical_payload: item.canonical_payload,
  };
}
