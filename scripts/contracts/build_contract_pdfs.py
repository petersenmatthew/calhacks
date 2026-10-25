"""
Build realistic PDF copies of the seeded provider contracts.

Clause text that agents cite is read from src/server/sim/seed.ts, so the PDFs always
match what the app quotes. Everything else (definitions, payment, liability, signatures)
is boilerplate around it. Writes, for each contract:
  public/contracts/<id>.pdf
  public/contracts/<id>-p<n>.png   small page thumbnails
and src/lib/contract-pdfs.json with each clause's page number.

Run: python3 scripts/contracts/build_contract_pdfs.py
"""

import json
import re
from pathlib import Path

import pypdfium2 as pdfium
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "contracts"
SEED = ROOT / "src" / "server" / "sim" / "seed.ts"


def seed_clauses():
    src = SEED.read_text()
    out = {}
    for name in ("HELIOS_CLAUSES", "STRATUS_CLAUSES", "MERIDIAN_CLAUSES"):
        block = re.search(name + r": ContractClause\[\] = \[(.*?)\n\];", src, re.S).group(1)
        out[name] = {
            m.group(1): (m.group(2), m.group(3))
            for m in re.finditer(r'\{ ref: "([^"]+)", title: "([^"]+)", text: "([^"]+)" \}', block)
        }
    return out


SEEDED = seed_clauses()

# ---------------------------------------------------------------- styles

INK = colors.HexColor("#1c1c1e")
GRAY = colors.HexColor("#6b6b70")
RULE = colors.HexColor("#c9c7c0")

body = ParagraphStyle("body", fontName="Times-Roman", fontSize=10.5, leading=14.2, textColor=INK, alignment=TA_JUSTIFY, spaceAfter=7)
clause = ParagraphStyle("clause", parent=body, leftIndent=0)
article = ParagraphStyle("article", fontName="Times-Bold", fontSize=11, leading=14, textColor=INK, spaceBefore=12, spaceAfter=6, keepWithNext=1)
title = ParagraphStyle("title", fontName="Times-Bold", fontSize=17, leading=21, alignment=TA_CENTER, textColor=INK, spaceAfter=4)
subtitle = ParagraphStyle("subtitle", fontName="Times-Roman", fontSize=10.5, leading=14, alignment=TA_CENTER, textColor=GRAY, spaceAfter=18)
small = ParagraphStyle("small", fontName="Helvetica", fontSize=8, leading=10, textColor=GRAY)
cell = ParagraphStyle("cell", fontName="Times-Roman", fontSize=10, leading=12.5, textColor=INK)
cellb = ParagraphStyle("cellb", parent=cell, fontName="Times-Bold")
sig = ParagraphStyle("sig", fontName="Times-Italic", fontSize=14, leading=16, textColor=colors.HexColor("#23315c"))


class Clause(Paragraph):
    """A numbered clause; remembers its ref so the build can record its page."""

    def __init__(self, ref, heading, text):
        super().__init__("<b>%s&nbsp;&nbsp;%s.</b>&nbsp;&nbsp;%s" % (ref, heading, text), clause)
        self.clause_ref = ref


class Doc(BaseDocTemplate):
    def __init__(self, path, meta):
        super().__init__(str(path), pagesize=LETTER, leftMargin=1.05 * inch, rightMargin=1.05 * inch, topMargin=1.0 * inch, bottomMargin=0.95 * inch,
                         title=meta["name"], author=meta["provider_legal"], subject=meta["id"])
        self.meta = meta
        self.pages = {}
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="f")
        self.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=self.decorate)])

    def afterFlowable(self, flowable):
        ref = getattr(flowable, "clause_ref", None)
        if ref:
            self.pages.setdefault(ref, self.page)

    def decorate(self, c, doc):
        m = self.meta
        w, h = LETTER
        c.saveState()
        if doc.page > 1:
            c.setFont("Helvetica", 7.5)
            c.setFillColor(GRAY)
            c.drawString(self.leftMargin, h - 0.6 * inch, m["provider_legal"] + " / Atlas Research, Inc.")
            c.drawRightString(w - self.rightMargin, h - 0.6 * inch, m["name"])
            c.setStrokeColor(RULE)
            c.setLineWidth(0.5)
            c.line(self.leftMargin, h - 0.66 * inch, w - self.rightMargin, h - 0.66 * inch)
        c.setFont("Helvetica", 7.5)
        c.setFillColor(GRAY)
        c.drawString(self.leftMargin, 0.55 * inch, "Agreement No. %s  |  Confidential" % m["id"])
        c.restoreState()


class NumberedCanvas(rl_canvas.Canvas):
    """Adds "Page X of Y" once the page count is known."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._saved = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        n = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self.setFont("Helvetica", 7.5)
            self.setFillColor(GRAY)
            self.drawRightString(LETTER[0] - 1.05 * inch, 0.55 * inch, "Page %d of %d" % (self._pageNumber, n))
            super().showPage()
        super().save()


# ---------------------------------------------------------------- content


def parties(meta):
    return Paragraph(
        "This %s (the \"Agreement\") is entered into as of %s (the \"Effective Date\") by and between "
        "<b>%s</b>, %s (\"Provider\"), and <b>Atlas Research, Inc.</b>, a Delaware corporation with offices at "
        "1200 Harbor Way, Suite 400, San Francisco, CA 94107 (\"Customer\"). Provider and Customer are each a \"Party\" and together the \"Parties.\""
        % (meta["name"], meta["effective_long"], meta["provider_legal"], meta["provider_desc"]),
        body,
    )


def head(meta):
    logo = ROOT / "public" / "logos" / meta["logo"]
    out = []
    if logo.exists():
        img = Image(str(logo), width=0.42 * inch, height=0.42 * inch)
        img.hAlign = "CENTER"
        out += [img, Spacer(1, 10)]
    out += [
        Paragraph(meta["doc_title"], title),
        Paragraph("Agreement No. %s&nbsp;&nbsp;&middot;&nbsp;&nbsp;Effective %s" % (meta["id"], meta["effective_long"]), subtitle),
        parties(meta),
    ]
    return out


def section(num, name, clauses):
    """An article heading followed by its clauses. Seeded clauses use the exact seeded text."""
    out = [Paragraph("%s.&nbsp;&nbsp;%s" % (num, name.upper()), article)]
    for ref, heading, text in clauses:
        out.append(Clause(ref, heading, text))
    return out


def seeded(table, ref):
    heading, text = SEEDED[table][ref]
    return (ref, heading, text)


def signature_block(meta):
    sigs = [
        [Paragraph("<b>%s</b>" % meta["provider_legal"], cell), Paragraph("<b>Atlas Research, Inc.</b>", cell)],
        [Paragraph(meta["signer"], sig), Paragraph("Priya Natarajan", sig)],
        [Paragraph("Name: %s<br/>Title: %s<br/>Date: %s" % (meta["signer"], meta["signer_title"], meta["signed"]), cell),
         Paragraph("Name: Priya Natarajan<br/>Title: Controller<br/>Date: %s" % meta["signed"], cell)],
    ]
    t = Table(sigs, colWidths=[3.1 * inch, 3.1 * inch])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 1), (-1, 1), 0.6, INK),
        ("TOPPADDING", (0, 1), (-1, 1), 14),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 18),
    ]))
    return KeepTogether([
        Paragraph("IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.", body),
        Spacer(1, 10),
        t,
        Spacer(1, 14),
        Paragraph("Executed electronically via Ironclad. Envelope ID %s." % meta["envelope"], small),
    ])


def rate_table(rows, head_row):
    data = [[Paragraph(h, cellb) for h in head_row]] + [[Paragraph(c, cell) for c in r] for r in rows]
    t = Table(data, colWidths=[2.2 * inch, 2.0 * inch, 2.1 * inch], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 0.8, INK),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, INK),
        ("LINEBELOW", (0, -1), (-1, -1), 0.8, INK),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


GENERAL = [
    ("Confidentiality", "Each Party shall hold the other Party's Confidential Information in confidence, use it only to perform under this Agreement, and protect it with at least the care it uses for its own information of like kind, and no less than reasonable care."),
    ("Limitation of liability", "Except for breach of confidentiality or a Party's indemnification obligations, neither Party is liable for indirect, incidental, or consequential damages, and each Party's aggregate liability is limited to the fees paid or payable in the twelve (12) months preceding the claim."),
    ("Governing law", "This Agreement is governed by the laws of the State of California, without regard to its conflict of laws rules. The state and federal courts in San Francisco County have exclusive jurisdiction."),
    ("Entire agreement", "This Agreement, including its exhibits and any order forms, is the entire agreement between the Parties on its subject matter and supersedes all prior proposals and understandings."),
]


def lambda_contract():
    T = "HELIOS_CLAUSES"
    meta = dict(
        id="HC-2025-114", name="Lambda Master Services Agreement", doc_title="MASTER SERVICES AGREEMENT", logo="lambda.png",
        provider_legal="Lambda, Inc.", provider_desc="a Delaware corporation with offices at 2510 Zanker Road, San Jose, CA 95131",
        effective_long="July 1, 2025", signed="June 24, 2025", signer="Marcus Ellery", signer_title="VP, Cloud Sales", envelope="IC-7Q2K-114-HL",
    )
    story = head(meta)
    story += section(1, "Definitions", [
        ("1.1", "Instance", "\"Instance\" means a GPU virtual machine provisioned by Provider for Customer, identified by a unique instance identifier."),
        ("1.2", "Lifecycle events", "\"PROVISIONED\" and \"TERMINATED\" mean the lifecycle states reported for an Instance by the Provider API, with their timestamps."),
        ("1.3", "Instance-hour", "\"Instance-hour\" means one hour, or part of an hour, during which an Instance is in a billable state."),
    ])
    story += section(2, "Services", [
        ("2.1", "Provision of services", "Provider will make on-demand and reserved GPU Instances available to Customer through the Provider console and API, subject to available capacity in the regions Customer selects."),
        ("2.2", "Customer accounts", "Customer is responsible for activity under its accounts and for keeping its API credentials secure."),
    ])
    story += section(3, "Fees", [
        seeded(T, "3.1"),
        ("3.2", "Taxes", "Fees exclude taxes. Customer will pay applicable sales, use, and similar taxes, other than taxes on Provider's income."),
        ("3.3", "Price changes", "Provider may change on-demand rates on thirty (30) days' written notice. Changes do not apply to usage before the notice period ends."),
    ])
    story += section(4, "Metering and billing", [
        seeded(T, "4.1"),
        seeded(T, "4.2"),
        seeded(T, "4.3"),
        seeded(T, "4.4"),
        ("4.5", "Invoices", "Provider will invoice monthly in arrears. Each invoice line identifies the Instance, the billed instance-hours, and the rate applied."),
    ])
    story += section(5, "Payment", [
        ("5.1", "Payment terms", "Customer will pay undisputed amounts within thirty (30) days of the invoice date."),
        ("5.2", "Disputed amounts", "Customer may withhold amounts disputed in good faith under Section 7 until the dispute is resolved. Undisputed amounts on the same invoice remain payable."),
    ])
    story += section(6, "Term and termination", [
        ("6.1", "Term", "This Agreement begins on the Effective Date and continues for twenty-four (24) months, renewing for successive twelve (12) month terms unless either Party gives sixty (60) days' notice of non-renewal."),
        ("6.2", "Termination for breach", "Either Party may terminate this Agreement if the other Party materially breaches it and fails to cure within thirty (30) days of written notice."),
    ])
    story += section(7, "Billing disputes", [
        ("7.1", "Notice of dispute", "Customer will notify Provider of a disputed charge in writing, identifying the invoice, the line, the amount disputed, and the basis for the dispute."),
        seeded(T, "7.2"),
        ("7.3", "Credits", "Credits issued under this Section are applied to the next invoice or, on Customer's request, refunded within thirty (30) days."),
    ])
    story += section(8, "General", [("8.%d" % (i + 1), h, t) for i, (h, t) in enumerate(GENERAL)])
    story += [Spacer(1, 12), signature_block(meta), PageBreak()]
    story += [Paragraph("EXHIBIT A&nbsp;&nbsp;&middot;&nbsp;&nbsp;RATE CARD", article), Spacer(1, 4),
              rate_table([["8x H100 (h100.8x)", "On-demand", "$100.00 per instance-hour"], ["8x A100 (a100.8x)", "On-demand", "$64.00 per instance-hour"]],
                         ["Instance type", "Commitment", "Rate"]),
              Spacer(1, 10), Paragraph("Rates are in U.S. dollars and exclude taxes. Metering and billing follow Section 4 of the Agreement.", body)]
    return meta, story


def coreweave_contract():
    T = "STRATUS_CLAUSES"
    meta = dict(
        id="SG-2026-007", name="CoreWeave Reserved Capacity Agreement", doc_title="RESERVED CAPACITY AGREEMENT", logo="coreweave.png",
        provider_legal="CoreWeave, Inc.", provider_desc="a Delaware corporation with offices at 290 W Mt. Pleasant Ave, Livingston, NJ 07039",
        effective_long="January 1, 2026", signed="December 18, 2025", signer="Elena Brandt", signer_title="Director, Strategic Accounts", envelope="IC-3F9D-007-CW",
    )
    story = head(meta)
    story += section(1, "Definitions", [
        ("1.1", "Reservation", "\"Reservation\" means a quantity of dedicated GPU capacity reserved for Customer for a fixed term, as stated on a Reservation Order."),
        ("1.2", "Reservation Order", "\"Reservation Order\" means an order signed by both Parties that states the capacity, term, region, and price of a Reservation."),
    ])
    story += section(2, "Reserved capacity", [
        seeded(T, "2.1"),
        ("2.2", "Reservation term", "Each Reservation runs for the term stated on its Reservation Order and begins when the capacity is made available to Customer."),
        ("2.3", "Availability", "CoreWeave will keep reserved capacity available to Customer for the full term, subject to the service levels in Section 4."),
        seeded(T, "2.4"),
        ("2.5", "Cancellation", "A Reservation may not be cancelled once its term begins, except for CoreWeave's uncured material breach."),
        seeded(T, "2.6"),
    ])
    story += section(3, "Payment", [
        ("3.1", "Invoicing", "CoreWeave will invoice each Reservation monthly in advance."),
        ("3.2", "Payment terms", "Customer will pay undisputed amounts within thirty (30) days of the invoice date."),
    ])
    story += section(4, "Service levels", [
        ("4.1", "Availability commitment", "Reserved capacity will be available 99.5% of each calendar month, excluding scheduled maintenance announced at least five (5) days in advance."),
        ("4.2", "Service credits", "If availability falls below the commitment, Customer receives a credit of 5% of that month's Reservation fee for each 0.5% shortfall, up to 30%."),
    ])
    story += section(5, "Term", [
        ("5.1", "Term", "This Agreement begins on the Effective Date and continues until all Reservation Orders under it have expired."),
    ])
    story += section(6, "Billing disputes", [
        seeded(T, "6.1"),
        ("6.2", "Resolution", "The Parties will work in good faith to resolve a dispute within thirty (30) days of notice. Undisputed amounts remain payable."),
    ])
    story += section(7, "General", [("7.%d" % (i + 1), h, t) for i, (h, t) in enumerate(GENERAL)])
    story += [Spacer(1, 12), signature_block(meta), PageBreak()]
    story += [Paragraph("SCHEDULE 1&nbsp;&nbsp;&middot;&nbsp;&nbsp;PRICING", article), Spacer(1, 4),
              rate_table([["8x H100 (h100.8x)", "Reserved, per order", "$88.00 per instance-hour"]], ["Capacity", "Commitment", "Rate"]),
              Spacer(1, 10), Paragraph("Reservation quantities and terms are set on each Reservation Order.", body)]
    return meta, story


def nebius_contract():
    T = "MERIDIAN_CLAUSES"
    meta = dict(
        id="MC-2026-031", name="Nebius Order Form", doc_title="ORDER FORM", logo="nebius.png",
        provider_legal="Nebius B.V.", provider_desc="a Dutch private limited company with offices at Schiphol Boulevard 165, Schiphol, the Netherlands",
        effective_long="February 15, 2026", signed="February 9, 2026", signer="Joris van Dijk", signer_title="Head of Enterprise Sales", envelope="IC-8B1M-031-NB",
    )
    story = head(meta)
    summary = Table(
        [[Paragraph(a, cellb), Paragraph(b, cell)] for a, b in [
            ("Order number", meta["id"]),
            ("Services", "On-demand GPU compute, 8x H200 instances"),
            ("Region", "eu-north1"),
            ("Order term", "12 months from the Effective Date"),
            ("Billing", "Monthly in arrears, net 30"),
        ]],
        colWidths=[1.8 * inch, 4.4 * inch], hAlign="LEFT",
    )
    summary.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story += [Spacer(1, 4), summary, Spacer(1, 8)]
    story += section(1, "Pricing", [
        ("1.1", "Services", "Nebius will provide the GPU compute services described in this Order Form under the Nebius Terms of Service, which are incorporated by reference."),
        seeded(T, "1.2"),
    ])
    story += section(2, "Payment", [
        ("2.1", "Payment terms", "Customer will pay each invoice within thirty (30) days of the invoice date."),
    ])
    story += section(3, "Usage and billing", [
        seeded(T, "3.1"),
        ("3.2", "Usage reports", "Nebius will make per-instance usage reports available in the console within twenty-four (24) hours of usage."),
        ("3.3", "Invoices", "Each invoice line identifies the instance, the billed hours, and the rate applied."),
        seeded(T, "3.4"),
        seeded(T, "3.5"),
        seeded(T, "3.6"),
    ])
    story += section(4, "Terms", [
        ("4.1", "Order of precedence", "If this Order Form conflicts with the Nebius Terms of Service, this Order Form controls for the services ordered here."),
        ("4.2", "Billing disputes", "Customer will raise any disputed charge in writing within sixty (60) days of the invoice date."),
    ])
    story += [Spacer(1, 12), signature_block(meta)]
    return meta, story


def build(meta, story):
    path = OUT / (meta["id"] + ".pdf")
    doc = Doc(path, meta)
    doc.build(story, canvasmaker=NumberedCanvas)
    for old in OUT.glob(meta["id"] + "-p*.png"):
        old.unlink()
    # Thumbnails for the preview cards, about 360 px wide.
    pdf = pdfium.PdfDocument(str(path))
    pages = len(pdf)
    for i in range(pages):
        img = pdf[i].render(scale=360 / LETTER[0]).to_pil()
        img.save(OUT / ("%s-p%d.png" % (meta["id"], i + 1)), optimize=True)
    pdf.close()
    return {"pdf": "/contracts/%s.pdf" % meta["id"], "pages": pages, "clausePages": doc.pages}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index = {}
    for make in (lambda_contract, coreweave_contract, nebius_contract):
        meta, story = make()
        index[meta["id"]] = build(meta, story)
    for key, table in (("HC-2025-114", "HELIOS_CLAUSES"), ("SG-2026-007", "STRATUS_CLAUSES"), ("MC-2026-031", "MERIDIAN_CLAUSES")):
        missing = set(SEEDED[table]) - set(index[key]["clausePages"])
        assert not missing, (key, missing)
    (ROOT / "src" / "lib" / "contract-pdfs.json").write_text(json.dumps(index, indent=2) + "\n")
    print(json.dumps(index, indent=2))


if __name__ == "__main__":
    main()
