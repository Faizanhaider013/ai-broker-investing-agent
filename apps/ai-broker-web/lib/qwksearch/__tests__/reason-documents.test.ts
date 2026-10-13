import { describe, expect, it } from "vitest"
import { mergeDocuments, rowToDocument, type ReasonDocument } from "../reason-documents"

const doc = (id: string, title = id): ReasonDocument => ({
  id,
  title,
  content: "",
  parentId: null,
  children: [],
  isExpanded: false,
  isFolder: false,
  tags: [],
})

describe("rowToDocument", () => {
  it("maps a row the way the editor's own sync loader does", () => {
    expect(
      rowToDocument({
        id: "7",
        title: "",
        content: "<p>x</p>",
        parentId: "3",
        isFolder: 1,
        isExpanded: 0,
        metadata: JSON.stringify({ tags: ["a", 1], isExpanded: false }),
      }),
    ).toEqual({
      id: "7",
      title: "Untitled",
      content: "<p>x</p>",
      parentId: "3",
      children: [],
      isExpanded: false,
      isFolder: true,
      tags: ["a"],
      metadata: { tags: ["a", 1], isExpanded: false },
    })
  })

  it("survives missing or broken metadata", () => {
    const row = { id: "1", title: "T", content: "", parentId: null, isFolder: 0, isExpanded: 1 }
    expect(rowToDocument({ ...row, metadata: null })).toMatchObject({ tags: [], metadata: undefined, isExpanded: true })
    expect(rowToDocument({ ...row, metadata: "{not json" })).toMatchObject({ tags: [], metadata: undefined })
  })
})

describe("mergeDocuments", () => {
  it("lets the account win on a shared id and keeps browser-only documents to upload", () => {
    const { documents, upload } = mergeDocuments([doc("1", "old"), doc("2")], [doc("1", "new"), doc("3")])
    expect(documents.map((d) => [d.id, d.title])).toEqual([
      ["1", "new"],
      ["3", "3"],
      ["2", "2"],
    ])
    expect(upload.map((d) => d.id)).toEqual(["2"])
  })

  it("drops a document deleted on another device instead of re-uploading it", () => {
    const { documents, upload } = mergeDocuments([doc("1"), doc("2")], [doc("1")], new Set(["1", "2"]))
    expect(documents.map((d) => d.id)).toEqual(["1"])
    expect(upload).toEqual([])
  })
})
