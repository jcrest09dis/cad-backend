import PDFDocument from "pdfkit";

/**
 * One PDF per event, covering every incident on it (any status) in
 * chronological order - location, type/priority, timeline, every
 * assignment, and the full note revision history (already decrypted by
 * the caller). This includes PHI, same as the existing Reports detail
 * view does on screen - the route calling this logs an audit entry per
 * incident whose notes were decrypted, same as the on-screen notes-read
 * paths elsewhere in the app.
 *
 * Returns a Promise<Buffer> rather than the raw PDFDocument stream -
 * piping the stream straight into the Fastify response turned out to be
 * unreliable (empty downloads), so the whole document is built and
 * collected into memory first. These reports are small enough that
 * buffering costs nothing meaningful.
 */
export function buildEventReportPdf({ event, incidents }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).fillColor("#000").text(`Incident Report \u2014 ${event.name}`);
    doc
      .fontSize(11)
      .fillColor("#555")
      .text(`${event.venue_name} \u2014 ${new Date(event.start_time).toLocaleString()}`);
    doc.moveDown();

    if (incidents.length === 0) {
      doc.fontSize(12).fillColor("#000").text("No incidents recorded for this event.");
      doc.end();
      return;
    }

    incidents.forEach((incident, idx) => {
      if (idx > 0) {
        doc
          .moveDown(0.5)
          .moveTo(doc.page.margins.left, doc.y)
          .lineTo(doc.page.width - doc.page.margins.right, doc.y)
          .strokeColor("#ccc")
          .stroke()
          .moveDown(0.5);
      }

      doc
        .fontSize(13)
        .fillColor("#000")
        .text(`${incident.zone_label ?? "Unknown location"} \u2014 ${incident.type}, ${incident.priority} priority`);
      doc
        .fontSize(10)
        .fillColor("#555")
        .text(`Status: ${incident.status}`)
        .text(`Created: ${new Date(incident.created_at).toLocaleString()} by ${incident.created_by_name}`);
      if (incident.closed_at) {
        doc.text(`Closed: ${new Date(incident.closed_at).toLocaleString()}`);
      }

      doc.moveDown(0.3).fontSize(11).fillColor("#000").text("Assignments:", { underline: true });
      if (incident.assignments.length === 0) {
        doc.fontSize(10).fillColor("#777").text("No unit was ever assigned.");
      } else {
        incident.assignments.forEach((a) => {
          let line = `${a.unit_label} \u2014 ${a.status.toLowerCase()}, dispatched by ${a.dispatcher_name} at ${new Date(a.created_at).toLocaleString()}`;
          if (a.acked_at) {
            line += `, acked at ${new Date(a.acked_at).toLocaleString()} by ${a.acked_by_name}`;
          }
          doc.fontSize(10).fillColor("#000").text(line);
        });
      }

      doc.moveDown(0.3).fontSize(11).fillColor("#000").text("Notes:", { underline: true });
      if (incident.noteRevisions.length === 0) {
        doc.fontSize(10).fillColor("#777").text("No notes were added.");
      } else {
        incident.noteRevisions.forEach((rev) => {
          doc
            .fontSize(9)
            .fillColor("#555")
            .text(`${rev.authorName}, ${new Date(rev.createdAt).toLocaleString()}`);
          doc.fontSize(10).fillColor("#000").text(rev.content, { indent: 10 });
        });
      }

      doc.moveDown();
    });

    doc.end();
  });
}
