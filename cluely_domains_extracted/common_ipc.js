//#region common/ipc.ts
var $;
(function(e) {
	function t(e, t) {
		c.on(e, (e, n) => {
			ly(e.senderFrame), t(n);
		});
	}
	e.on = t;
	function n(e, t) {
		c.handle(e, (e, n) => (ly(e.senderFrame), t(n)));
	}
	e.handle = n;
})($ ||= {});
var cy = new URL(j.VITE_RENDERER_URL).origin;
function ly(e) {
	if (!uy(e)) throw Error(`Rejected IPC sender with invalid origin: ${e?.url}`);
}
function uy(e) {
	return !e || !URL.canParse(e.url) ? !1 : new URL(e.url).origin === cy;
}
//#endregion
