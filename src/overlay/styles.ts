export const OVERLAY_CSS = `
:host { all: initial; }
.root {
  position: fixed; left: 0; top: 0; width: 0; height: 0;
  pointer-events: none; z-index: 2147483646; overflow: hidden;
  contain: layout style;
}
.box {
  position: absolute; left: 50%; transform: translateX(-50%);
  width: max-content; max-width: 92%; text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: .18em;
}
.line {
  display: inline-block; padding: .08em .45em; border-radius: .22em;
  font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
  line-height: 1.32; white-space: pre-wrap; overflow-wrap: anywhere;
  color: #fff; font-weight: 600; letter-spacing: .005em;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
.en { font-size: .78em; font-weight: 500; color: #e9e9e9; }
.pending { opacity: .72; font-style: italic; font-weight: 500; }
.hidden { display: none !important; }
.badge {
  position: absolute; top: 10px; left: 10px; padding: 3px 8px; border-radius: 999px;
  background: rgba(200, 20, 30, .88); color: #fff; font: 600 12px/1.4 system-ui, sans-serif;
  display: flex; align-items: center; gap: 6px;
}
.badge::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: blink 1.2s infinite; }
@keyframes blink { 50% { opacity: .2; } }
@media (prefers-reduced-motion: reduce) { .badge::before { animation: none; } }
`;
