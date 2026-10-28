//#region electron/domains/session.ts
var ny;
(function(e) {
	let t = null, n = null;
	function r() {
		i(Q.getSharedState());
	}
	e.init = r;
	function i(e) {
		let t = e.session;
		if (!t || e.showSessionInactivityModal) {
			o(), n = null;
			return;
		}
		let r = {
			sessionId: t.id,
			transcriptLength: t.transcript.length,
			messagesLength: t.messagesLength
		};
		n && ye(n, r) || (n = r, a());
	}
	e.update = i;
	function a() {
		o(), t = setTimeout(() => {
			t = null, Q.patchSharedState({
				showChat: !1,
				showDashboard: !0,
				dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1,
				showSessionInactivityModal: !0
			});
		}, 6e5);
	}
	function o() {
		t &&= (clearTimeout(t), null);
	}
})(ny ||= {});
//#endregion
