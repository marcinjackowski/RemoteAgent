#!/usr/bin/env swift
import AppKit
import CoreGraphics
import CoreText
import PDFKit

// Reproducible, dependency-free renderer for the RA-055 architecture checkpoint.
// Usage: swift scripts/docs/render-engineering-loop-pdf.swift [output.pdf]

let output = CommandLine.arguments.dropFirst().first ?? "docs/architecture/ENGINEERING_LOOP_DIAGRAM.pdf"
let page = CGSize(width: 842, height: 595) // A4 landscape, points
let margin: CGFloat = 42
let navy = CGColor(red: 0.07, green: 0.13, blue: 0.22, alpha: 1)
let ink = CGColor(red: 0.12, green: 0.16, blue: 0.22, alpha: 1)
let muted = CGColor(red: 0.34, green: 0.39, blue: 0.47, alpha: 1)
let blue = CGColor(red: 0.10, green: 0.38, blue: 0.72, alpha: 1)
let teal = CGColor(red: 0.05, green: 0.49, blue: 0.48, alpha: 1)
let orange = CGColor(red: 0.88, green: 0.43, blue: 0.13, alpha: 1)
let red = CGColor(red: 0.73, green: 0.18, blue: 0.18, alpha: 1)
let paleBlue = CGColor(red: 0.91, green: 0.95, blue: 0.99, alpha: 1)
let paleTeal = CGColor(red: 0.90, green: 0.97, blue: 0.96, alpha: 1)
let paleOrange = CGColor(red: 1.0, green: 0.95, blue: 0.87, alpha: 1)
let paleRed = CGColor(red: 1.0, green: 0.92, blue: 0.92, alpha: 1)

var mediaBox = CGRect(origin: .zero, size: page)
guard let ctx = CGContext(URL(fileURLWithPath: output) as CFURL, mediaBox: &mediaBox, nil) else {
    fatalError("Nie można utworzyć pliku PDF: \(output)")
}
func beginPage() {
    ctx.beginPDFPage([kCGPDFContextMediaBox: CGRect(origin: .zero, size: page)] as CFDictionary)
    ctx.saveGState()
    ctx.setFillColor(CGColor.white)
    ctx.fill(CGRect(origin: .zero, size: page))
    ctx.restoreGState()
}
beginPage()

func font(_ size: CGFloat, bold: Bool = false) -> NSFont {
    NSFont(name: bold ? "Helvetica-Bold" : "Helvetica", size: size) ?? NSFont.systemFont(ofSize: size, weight: bold ? .bold : .regular)
}
func text(_ value: String, at p: CGPoint, width: CGFloat, size: CGFloat = 11, color: CGColor = ink, bold: Bool = false, line: CGFloat = 1.18) {
    let style = NSMutableParagraphStyle(); style.lineSpacing = size * (line - 1); style.lineBreakMode = .byWordWrapping
    let a = NSAttributedString(string: value, attributes: [.font: font(size, bold: bold), .foregroundColor: NSColor(cgColor: color) ?? .black, .paragraphStyle: style])
    let frame = CTFramesetterCreateFrame(CTFramesetterCreateWithAttributedString(a), CFRangeMake(0, a.length), CGPath(rect: CGRect(x: p.x, y: page.height - p.y - 200, width: width, height: 200), transform: nil), nil)
    ctx.saveGState(); CTFrameDraw(frame, ctx); ctx.restoreGState()
}
func rect(_ r: CGRect, fill: CGColor, stroke: CGColor? = nil, radius: CGFloat = 10) {
    let q = CGRect(x: r.minX, y: page.height - r.maxY, width: r.width, height: r.height)
    ctx.saveGState(); ctx.setFillColor(fill); ctx.addPath(CGPath(roundedRect: q, cornerWidth: radius, cornerHeight: radius, transform: nil)); ctx.fillPath()
    if let stroke { ctx.setStrokeColor(stroke); ctx.setLineWidth(1); ctx.addPath(CGPath(roundedRect: q, cornerWidth: radius, cornerHeight: radius, transform: nil)); ctx.strokePath() }; ctx.restoreGState()
}
func line(_ a: CGPoint, _ b: CGPoint, color: CGColor = blue, width: CGFloat = 2, arrow: Bool = true) {
    let aa = CGPoint(x: a.x, y: page.height - a.y), bb = CGPoint(x: b.x, y: page.height - b.y)
    ctx.saveGState(); ctx.setStrokeColor(color); ctx.setLineWidth(width); ctx.move(to: aa); ctx.addLine(to: bb); ctx.strokePath()
    if arrow { let dx=bb.x-aa.x, dy=bb.y-aa.y, l=max(1, sqrt(dx*dx+dy*dy)), ux=dx/l, uy=dy/l; let s:CGFloat=7; ctx.move(to:bb); ctx.addLine(to:CGPoint(x:bb.x-ux*s-uy*s/2,y:bb.y-uy*s+ux*s/2)); ctx.move(to:bb); ctx.addLine(to:CGPoint(x:bb.x-ux*s+uy*s/2,y:bb.y-uy*s-ux*s/2)); ctx.strokePath() }; ctx.restoreGState()
}
func title(_ t: String, _ subtitle: String, pageNumber: Int) {
    text("REMOTEAGENT  /  ENGINEERING LOOP", at: CGPoint(x: margin, y: 35), width: 500, size: 9, color: blue, bold: true)
    text(t, at: CGPoint(x: margin, y: 56), width: 750, size: 25, color: navy, bold: true)
    text(subtitle, at: CGPoint(x: margin, y: 91), width: 730, size: 11, color: muted)
    text("RA-055 • checkpoint 2026-09-06 • strona \(pageNumber)/4", at: CGPoint(x: margin, y: 558), width: 760, size: 8, color: muted)
}
func box(_ r: CGRect, _ heading: String, _ body: String, fill: CGColor = paleBlue, accent: CGColor = blue) {
    rect(r, fill: fill, stroke: accent); rect(CGRect(x:r.minX,y:r.minY,width:5,height:r.height), fill:accent, radius:2)
    text(heading, at: CGPoint(x:r.minX+18,y:r.minY+13), width:r.width-28, size:12, color:navy, bold:true)
    text(body, at: CGPoint(x:r.minX+18,y:r.minY+35), width:r.width-30, size:9.5, color:ink, line:1.22)
}

// Page 1: the end-to-end path.
title("Engineering Loop: od zadania do bezpiecznego commitu", "Pętla wykonuje pracę w izolacji, dowodzi jej komendami i zatrzymuje się przy każdej niejednoznaczności.", pageNumber: 1)
let xs:[CGFloat] = [42, 197, 352, 507, 662]; let labels = [("1  WEJŚCIE","Task + manifest\nZakres, kryteria i zależności"),("2  PLAN","Role subskrypcyjne\nImplementer / reviewer"),("3  SLICE","Test-first\nMała zmiana + test"),("4  DOWÓD","Serwerowy katalog gate'ów\nReceipt: baseline RED → current GREEN"),("5  WYJŚCIE","Świeży review → final verifier\nLokalny commit związany z dowodem")]
for i in 0..<5 { box(CGRect(x:xs[i],y:190,width:138,height:115), labels[i].0, labels[i].1, fill: i == 3 ? paleOrange : (i == 4 ? paleTeal : paleBlue), accent: i == 3 ? orange : (i == 4 ? teal : blue)); if i < 4 { line(CGPoint(x:xs[i]+138,y:248), CGPoint(x:xs[i+1]-8,y:248)) } }
box(CGRect(x:42,y:355,width:365,height:120), "AUTORYTET SERWERA", "Polityka, scope, manifest i kolejność są ustalane deterministycznie poza modelem. Treści z systemów zewnętrznych są UNTRUSTED_DATA. Model nie może poszerzyć uprawnień argumentem narzędzia.", fill:paleRed, accent:red)
box(CGRect(x:435,y:355,width:365,height:120), "IZOLACJA I ŚLAD", "Jeden writer na workspace/case_id. Każde wywołanie ma osobny journal, changelog, evidence receipt i accounting tokenów. Worktree pozostaje odseparowany od źródła użytkownika.", fill:paleTeal, accent:teal)

// Page 2: control plane and execution loop.
ctx.endPDFPage(); beginPage()
title("Co dzieje się wewnątrz jednego slice", "Korekty są ograniczone, a każdy etap zostawia obserwowalny stan i bezpieczny następny krok.", pageNumber: 2)
let ys:[CGFloat] = [157, 260, 363]; let steps:[(String,String,CGColor)] = [("Implementacja","Model czyta dozwolony kontekst i tworzy zmianę.",blue),("Dowód test-first","Ten sam gate porównuje baseline RED z current GREEN. To receipt porównawczy, nie automatyczna mutacja wykonywana przez Sol.",orange),("Review + correction","Świeży reviewer ocenia aktualny diff i dowód. CHANGES_REQUIRED wraca do implementera tylko w ramach capu.",teal)]
for i in 0..<3 { box(CGRect(x:55,y:ys[i],width:290,height:76), steps[i].0, steps[i].1, fill:i==1 ? paleOrange : (i==2 ? paleTeal:paleBlue), accent:steps[i].2); if i<2 { line(CGPoint(x:200,y:ys[i]+76),CGPoint(x:200,y:ys[i+1]-8),color:steps[i].2) } }
line(CGPoint(x:45,y:392), CGPoint(x:45,y:198), color:teal)
text("korekta", at: CGPoint(x: 5, y: 280), width: 40, size: 8, color: teal, bold: true)
box(CGRect(x:430,y:157,width:350,height:116), "FAST GATES", "Serwerowy katalog repozytorium docelowego uruchamia wybrane komendy i zapisuje receipts.\n\nKażdy receipt wiąże komendę, cel, kod wyjścia i dowód. RemoteAgent workflow:validate oraz flagi PG to kontrole deweloperskie, nie bramki celu.", fill:paleBlue, accent:blue)
box(CGRect(x:430,y:302,width:350,height:116), "FULL XCODE GATE", "Na iOS uruchamiany jest dokładny scheme, simulator i zestaw testów. Błąd kompilatora może uruchomić ograniczoną pętlę repair → gate. Brak miejsca na dysku to RESOURCE_LIMIT, nie błąd kodu.", fill:paleOrange, accent:orange)
box(CGRect(x:430,y:447,width:350,height:62), "ŚLAD", "Journal zapisuje decyzje, komendy, czasy, retry, review i tokeny; bez sekretów ani pełnego celu.", fill:paleTeal, accent:teal)

// Page 3: verification gates and terminal semantics.
ctx.endPDFPage(); beginPage()
title("Bramka weryfikacyjna i terminal outcomes", "Status nie wynika z komentarza ani deklaracji agenta — wyłącznie z uruchomionej komendy i kompletnego receipt.", pageNumber: 3)
box(CGRect(x:48,y:150,width:225,height:130), "GATE: RED", "Komenda zwróciła exit ≠ 0.\n\n→ diagnoza\n→ minimalna korekta\n→ ponowny gate", fill:paleRed, accent:red)
box(CGRect(x:308,y:150,width:225,height:130), "GATE: GREEN", "Komenda zwróciła exit 0.\n\nTo dowód tylko tego etapu; pełna bramka taska nadal jest wymagana.", fill:paleTeal, accent:teal)
box(CGRect(x:568,y:150,width:225,height:130), "REVIEW: PASS", "Świeży reviewer widzi aktualny diff i dowody. Dopiero wtedy możliwy jest final verifier.", fill:paleBlue, accent:blue)
line(CGPoint(x:273,y:215),CGPoint(x:300,y:215),color:blue); line(CGPoint(x:533,y:215),CGPoint(x:560,y:215),color:teal)
box(CGRect(x:48,y:338,width:350,height:145), "TERMINALNE WYNIKI ENGINEERING", "COMPLETED — wymagany dowód jest kompletny.\nBLOCKED / FAILED / CANCELLED — praca nie może kontynuować się bez zmiany warunków.\nWAITING / INCOMPLETE / UNKNOWN — bez deklaracji ukończenia; wybierz bezpieczny następny krok.", fill:paleBlue, accent:blue)
box(CGRect(x:425,y:338,width:368,height:145), "KLASY BŁĘDÓW GATE", "INFRASTRUCTURE to klasa błędu gate, nie status run: środowisko uniemożliwiło dowód (np. RESOURCE_LIMIT). Brak receipt to AMBIGUOUS i wymaga RECONCILE. Loop nigdy nie uznaje żadnego z tych przypadków za green.", fill:paleRed, accent:red)

// Page 4: deployment model and current boundaries.
ctx.endPDFPage(); beginPage()
title("Model, role i granice odpowiedzialności", "Konfiguracja preferuje interaktywne subskrypcje Codex/Claude; kanały API nie są ukrytym fallbackiem.", pageNumber: 4)
box(CGRect(x:48,y:150,width:230,height:117), "IMPLEMENTER", "Wybrany model subskrypcyjny wykonuje bounded slice w izolowanym worktree. Nie może sam uznać zadania za DONE.", fill:paleBlue, accent:blue)
box(CGRect(x:306,y:150,width:230,height:117), "REVIEWER", "Osobne, świeże wywołanie ocenia diff, testy i kompletność dowodu. Wybór implementera/reviewera pozostaje konfigurowalny.", fill:paleTeal, accent:teal)
box(CGRect(x:564,y:150,width:230,height:117), "FINAL VERIFIER", "Skonfigurowana rola subskrypcyjna uruchamia końcową ścieżkę weryfikacji i emituje trwały dowód. To nie jest rola deweloperskiego/audytowego primary Sol.", fill:paleOrange, accent:orange)
line(CGPoint(x:278,y:208),CGPoint(x:298,y:208)); line(CGPoint(x:536,y:208),CGPoint(x:556,y:208))
box(CGRect(x:48,y:320,width:746,height:83), "SUBSKRYPCJE I TRYBY", "Codex i Claude są używane przez zalogowane subskrypcje, bez kluczy API. Bedrock i OpenCode są obecnie nieaktywne w tej ścieżce. Sol/Luna to orchestration repozytorium; nie jest tożsama z wyborem modelu live Engineering.", fill:paleBlue, accent:blue)
box(CGRect(x:48,y:430,width:360,height:82), "CAPY I RETRY", "Korekty review są limitowane per slice/mode. SEARCH/READ, compiler repair i retry mają osobne, jawne limity; przekroczenie kończy się terminalnym INCOMPLETE lub FAILED.", fill:paleOrange, accent:orange)
box(CGRect(x:434,y:430,width:360,height:82), "FINALNY HANDOFF", "Engineering: gates → świeży review → korekty / następny slice → final verifier → lokalny commit związany z dowodem. Developer Sol/Luna osobno czyta diff, uruchamia verification/audit workflow i akceptuje wynik.", fill:paleTeal, accent:teal)

ctx.endPDFPage(); ctx.closePDF()
let pdf = PDFDocument(url: URL(fileURLWithPath: output))
guard let pdf, pdf.pageCount > 0 else { fatalError("PDF nie zawiera stron") }
print("Wygenerowano \(output): \(pdf.pageCount) stron")
