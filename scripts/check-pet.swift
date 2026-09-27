// Checks a Codex pet (a folder with pet.json + spritesheet, or the pet.json itself) against
// the atlas Codex and StudyPet expect (hatch-pet references/animation-rows.md).
//
//   swift scripts/check-pet.swift ~/.codex/pets/nailong
import CoreGraphics
import Foundation
import ImageIO

let cellW = 192
let cellH = 208
let cols = 8
/// Row → state and the frames it should use. Idle may carry a 7th "neutral" frame.
let rowsSpec: [(state: String, frames: Int)] = [
    ("idle", 6), ("running-right", 8), ("running-left", 8), ("waving", 4), ("jumping", 5),
    ("failed", 8), ("waiting", 6), ("running", 6), ("review", 6),
]

var problems = 0
var warnings = 0
func ok(_ s: String) { print("✓ \(s)") }
func warn(_ s: String) { warnings += 1; print("⚠ \(s)") }
func fail(_ s: String) { problems += 1; print("✗ \(s)") }

guard CommandLine.arguments.count > 1 else {
    print("用法：swift scripts/check-pet.swift <宠物文件夹或 pet.json>")
    exit(2)
}
let input = URL(fileURLWithPath: (CommandLine.arguments[1] as NSString).expandingTildeInPath)
var isDir: ObjCBool = false
FileManager.default.fileExists(atPath: input.path, isDirectory: &isDir)
let manifestURL = isDir.boolValue ? input.appendingPathComponent("pet.json") : input

// pet.json
guard let data = try? Data(contentsOf: manifestURL),
      let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
    fail("读不到 pet.json：\(manifestURL.path)")
    exit(1)
}
ok("pet.json：\(json["displayName"] ?? json["id"] ?? "（没有名字）")")
if json["id"] == nil { warn("pet.json 缺少 id") }
if json["displayName"] == nil { warn("pet.json 缺少 displayName") }
let version = json["spriteVersionNumber"] as? Int ?? 1
let sheetURL = manifestURL.deletingLastPathComponent().appendingPathComponent(json["spritesheetPath"] as? String ?? "spritesheet.webp")

// Spritesheet
guard let source = CGImageSourceCreateWithURL(sheetURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("打不开精灵图：\(sheetURL.lastPathComponent)")
    exit(1)
}
let W = image.width
let H = image.height
let rows = H / cellH
if W != cols * cellW || H % cellH != 0 || rows < 9 {
    fail("尺寸 \(W)×\(H) 不对：需要 1536×1872（9 行）或 1536×2288（11 行，带看向方向），每格 192×208")
    exit(1)
}
ok("尺寸 \(W)×\(H)：8 列 × \(rows) 行，每格 192×208")
if (version >= 2) != (rows >= 11) {
    warn("spriteVersionNumber=\(version) 和行数 \(rows) 对不上（v1 是 9 行，v2 是 11 行）")
}
if [.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo) {
    fail("精灵图没有透明通道：背景必须是透明的")
}

var px = [UInt8](repeating: 0, count: W * H * 4)
let ctx = CGContext(data: &px, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(image, in: CGRect(x: 0, y: 0, width: W, height: H))
func alpha(_ x: Int, _ y: Int) -> UInt8 { px[(y * W + x) * 4 + 3] }

struct Cell { var used = false; var touchesEdge = false; var opaqueCorners = false }
func cell(_ r: Int, _ c: Int) -> Cell {
    var out = Cell()
    let x0 = c * cellW
    let y0 = r * cellH
    for y in y0..<(y0 + cellH) {
        for x in x0..<(x0 + cellW) where alpha(x, y) > 24 {
            out.used = true
            if x == x0 || y == y0 || x == x0 + cellW - 1 || y == y0 + cellH - 1 { out.touchesEdge = true }
        }
    }
    let corners = [(x0, y0), (x0 + cellW - 1, y0), (x0, y0 + cellH - 1), (x0 + cellW - 1, y0 + cellH - 1)]
    out.opaqueCorners = corners.filter { alpha($0.0, $0.1) > 200 }.count >= 3
    return out
}

// The nine animation rows
for (r, spec) in rowsSpec.enumerated() {
    let cells = (0..<cols).map { cell(r, $0) }
    let used = cells.enumerated().filter { $0.element.used }.map { $0.offset }
    let contiguous = used == Array(0..<used.count)
    let label = "第 \(r + 1) 行 \(spec.state)"
    if used.isEmpty {
        fail("\(label)：是空的")
        continue
    }
    if !contiguous { fail("\(label)：用到的格子要从最左边连续排（现在是 \(used)）") }
    let allowed = spec.state == "idle" ? [6, 7] : [spec.frames]
    if allowed.contains(used.count) {
        ok("\(label)：\(used.count) 帧")
    } else {
        warn("\(label)：\(used.count) 帧，规格是 \(spec.frames) 帧")
    }
    if cells.contains(where: { $0.opaqueCorners }) { fail("\(label)：格子四角不透明，背景没抠干净") }
    if cells.contains(where: { $0.touchesEdge }) { warn("\(label)：有帧贴到格子边上，可能被裁掉了一部分") }
}

// v2: 16 look directions (rows 10–11), which let the pet turn toward the cursor
if rows >= 11 {
    let looks = (9..<11).flatMap { r in (0..<cols).map { cell(r, $0) } }
    let filled = looks.filter { $0.used }.count
    if filled == 16 {
        ok("16 个看向方向都有：宠物会转头看鼠标")
    } else {
        fail("看向方向只有 \(filled)/16 个")
    }
    if looks.contains(where: { $0.opaqueCorners }) { fail("看向方向的格子背景没抠干净") }
} else {
    warn("没有看向方向（v2 的第 10–11 行）：宠物不会转头看鼠标。用 spriteVersionNumber 2 生成 8×11 的图就有了")
}

print(problems == 0
      ? (warnings == 0 ? "\n全部符合规格，可以直接导入 StudyPet 🎉" : "\n可以导入，有 \(warnings) 个小提醒")
      : "\n有 \(problems) 个问题需要修一下")
exit(problems == 0 ? 0 : 1)
