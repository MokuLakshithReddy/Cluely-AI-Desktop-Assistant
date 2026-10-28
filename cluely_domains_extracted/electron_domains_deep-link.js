//#region electron/domains/deep-link.ts
var sy;
(function(e) {
	function t() {
		ae.on("request", a), ae.initialize({
			protocol: j.VITE_DESKTOP_SCHEME,
			mode: me ? "development" : "production"
		}), _.info(`Initialized handler for for scheme: ${j.VITE_DESKTOP_SCHEME}://`), me && (console.log("If you see errors like 'bootstrap_look_up XXX: Permission denied (1100)', run the following in repo root:"), console.log("sudo xattr -r -d com.apple.quarantine ./"));
	}
	e.init = t;
	let n = null;
	function r() {
		let e = n;
		return n = null, e;
	}
	e.consumeLastAuthToken = r;
	function a(e) {
		if (!URL.canParse(e)) return;
		let t = new URL(e);
		Q.patchSharedState({
			showDashboard: !0,
			dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1
		}), process.platform !== "darwin" && i.focus();
		let r = Z.Auth.getWindow();
		if (t.hostname === "auth" && t.pathname === "/success" && r) {
			if (Q.getSharedState().signInStatus === "signed-in") return;
			n = t.searchParams.get("token"), Z.navigate(r, {
				to: "/auth/success",
				search: { key: crypto.randomUUID() }
			});
			return;
		}
		if (t.hostname === "auth" && t.pathname === "/refresh") {
			Q.patchSharedState({ authRefreshCount: Q.getSharedState().authRefreshCount + 1 });
			return;
		}
		if (t.hostname === "dashboard" && t.pathname === "/calendar-connected") {
			Q.patchSharedState({
				showDashboard: !0,
				dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1
			}), Z.broadcastIpc("dashboard-calendar-connected");
			return;
		}
	}
})(sy ||= {});
//#endregion
