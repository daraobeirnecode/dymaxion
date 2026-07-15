---
slug: story-map-scaffold
name: Story Map Scaffold
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Story Map Scaffold

## Purpose

Generate an ArcGIS StoryMap draft from a narrative outline plus a set of
existing web maps and images, using the StoryMap REST API. Creates a draft
item only — the publish endpoint is never called, so nothing goes public.

## When to use this skill

- User has maps/images and an outline and wants a first-draft StoryMap to
  refine in the builder
- Turning a completed analysis (e.g. a `parcel-brief` series) into a
  presentable narrative

## When NOT to use this skill

- User wants a data dashboard with live widgets — use `dashboard-scaffold`
- Publishing or sharing a StoryMap — draft only; the user publishes manually
  from the builder (production publish requires approval outside this skill)
- The referenced maps don't exist yet — build them first; this skill does
  not create web maps

## Inputs

- `title` (string, required): StoryMap title
- `narrative_outline` (string, required): ordered outline of sections, one
  line or numbered item per section
- `map_item_ids` (array, optional): web map item ids to embed
- `image_urls` (array, optional): image URLs to place in sections
- `target_folder` (string, optional): destination folder in the org

## Outputs

- `storymap_item_id` (string): item id of the created draft
- `draft_url` (string): StoryMaps builder URL for the draft

## Tools required

- `esri-mcp` — item access checks, addItem, StoryMap REST API calls

## Execution plan

1. Verify each `map_item_ids` entry resolves and is accessible to the org
   account; verify each image URL answers a HEAD request
2. Workhorse LLM expands `narrative_outline` into section drafts — heading,
   body copy, and which map/image each section uses
3. Assemble the StoryMap JSON node tree: cover (title), one section per
   outline entry, map actions for embedded maps
4. Create the item via the StoryMap REST API as a draft (`smstatusdraft`
   typeKeyword); never call the publish endpoint
5. Attach image resources to the item
6. Return `storymap_item_id` + `draft_url`

## LLM prompts

### Section drafting (workhorse tier)

System: You draft StoryMap section content from an outline. Factual tone,
short paragraphs, no adjectives beyond what the source material states.
Every section must name which provided map or image it uses, or 'none'.
Output JSON only: [{"heading": ..., "body": ..., "media_ref": ...}].

User: Title: {title}. Outline: {narrative_outline}. Available maps
(id, title, summary): {maps_json}. Available images: {image_urls}. Draft
one section per outline entry.

## Failure modes

- A map item is inaccessible — substitute a placeholder block in that
  section, flag it in the draft text, and continue
- StoryMap API rejects the assembled JSON — retry once with a minimal valid
  tree (cover + text sections), then attach media incrementally
- An image URL is unreachable at HEAD check — skip it and note the skip in
  the section body
- Org account lacks StoryMaps entitlement — fail with the exact licensing
  requirement; nothing is created

## Cost + timeout

- Max cost per invocation: $0.80 (budget cap)
- Max duration: 300 seconds
- Typical actual cost: $0.40, typical duration: 45-90 seconds
