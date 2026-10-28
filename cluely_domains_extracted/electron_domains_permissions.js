//#region electron/domains/permissions.ts
var dy;
(function(e) {
	function t() {
		r();
	}
	e.init = t;
	async function n(e) {
		switch (e) {
			case "microphone":
				i(e, await g.askForMediaAccess("microphone") ? "granted" : "denied");
				break;
			case "screen":
				i(e, await s() ? "granted" : "denied");
				break;
			case "accessibility":
				i(e, g.isTrustedAccessibilityClient(!0) ? "granted" : "denied");
				break;
		}
	}
	e.askForAccess = n;
	function r() {
		if (process.platform !== "darwin") {
			Q.patchSharedState({ permissions: {
				microphone: "granted",
				screen: "granted",
				accessibility: "granted"
			} });
			return;
		}
		let e = Q.getSharedState(), t = { ...e.permissions };
		e.permissions.microphone !== "unknown" && (t.microphone = o(g.getMediaAccessStatus("microphone"))), e.permissions.screen !== "unknown" && (t.screen = o(g.getMediaAccessStatus("screen"))), e.permissions.accessibility !== "unknown" && (t.accessibility = g.isTrustedAccessibilityClient(!1) ? "granted" : "denied"), Q.patchSharedState({ permissions: t });
	}
	e.check = r;
	function i(e, t) {
		let n = Q.getSharedState();
		Q.patchSharedState({ permissions: {
			...n.permissions,
			[e]: t
		} });
	}
	function o(e) {
		return e === "granted" ? "granted" : e === "denied" || e === "restricted" ? "denied" : "unknown";
	}
	async function s() {
		try {
			return await a.getSources({ types: ["screen"] }), !0;
		} catch {
			return !1;
		}
	}
})(dy ||= {});
//#endregion
