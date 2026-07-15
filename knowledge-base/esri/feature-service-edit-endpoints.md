---
title: Feature Service Edit Endpoints (applyEdits, addFeatures, updateFeatures)
category: esri
topic_tags: [rest-api, editing, applyedits, feature-service, attachments, versioning]
status: stub
---

# Feature Service Edit Endpoints (applyEdits, addFeatures, updateFeatures)

Reference for write operations against editable feature services — all of which are destructive and require approval under Dymaxion's rules. Layer-level endpoints `addFeatures`, `updateFeatures`, and `deleteFeatures` take a `features` array of `{geometry, attributes}` JSON (deletes take `objectIds` or a `where` clause); the service-level `applyEdits` endpoint batches adds/updates/deletes across multiple layers in one transactional call with `rollbackOnFailure=true`. Each edit response returns per-feature `success` flags plus `objectId` and `globalId`, which must be checked — HTTP 200 does not mean the edits applied. Updates match features by `objectId` (or `globalId` when `useGlobalIds=true`, the safer pattern for offline/distributed editing). Covers attachment endpoints (`addAttachment`, `updateAttachment`, `deleteAttachments`), the `/admin` manager endpoints for schema changes (`addToDefinition`, `updateDefinition`, `deleteFromDefinition` on `rest/admin/services`), and `truncate` for hosted layers. Notes on editor tracking fields (created_user, last_edited_date), branch-versioned services requiring `sessionId` and version management via the VersionManagementServer, and the `supportsApplyEditsWithGlobalIds` capability flag. Edits require a token whose user has editing privileges on the layer.

TODO: expand from authoritative source (developers.arcgis.com/rest "Apply Edits (Feature Service)" and feature layer admin references).
