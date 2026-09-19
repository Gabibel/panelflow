// ESM face of shared/report.js, the way search.js has one: the shared file
// publishes itself on globalThis because content scripts cannot be modules,
// and this re-export lets the tests read the report the way the phone, the
// extension and the web app write it.
import '../../shared/report.js';

export const {
  REPORT_TO,
  KEEP,
  createDiagnostics,
  fromTrail,
  reportLines,
  mailto,
} = globalThis.PanelFlowReport;
