import { describe, expect, it } from "vitest"
import { PLACE_STATUSES, SEO_PAGE_STATUSES, SEO_PAGE_TYPES } from "@/lib/domain/constants"
import type { PlaceStatus, SeoPageStatus, SeoPageType } from "@/lib/domain/constants"

const placeSeoPageTypeAccepted: "place" extends SeoPageType ? true : false = true
const noindexPlaceStatusAccepted: "noindex" extends PlaceStatus ? true : false = true
const noindexSeoPageStatusRejected: "noindex" extends SeoPageStatus ? true : false = false
const readySeoPageStatusAccepted: "ready" extends SeoPageStatus ? true : false = true

void placeSeoPageTypeAccepted
void noindexPlaceStatusAccepted
void noindexSeoPageStatusRejected
void readySeoPageStatusAccepted

describe("SEO page type contracts", () => {
  it("keeps place SEO pages and independent status lifecycles", () => {
    expect(SEO_PAGE_TYPES).toContain("place")
    expect(SEO_PAGE_STATUSES).toContain("ready")
    expect(SEO_PAGE_STATUSES).not.toContain("noindex")
    expect(PLACE_STATUSES).toContain("noindex")
  })
})
