//#region electron/domains/tray.ts
var iy;
(function(t) {
	let a = null, o = null, s = null;
	function c() {
		u(Q.getSharedState());
	}
	t.init = c;
	function u(t) {
		if (!Z.areAppWindowsLoaded(t) || t.isInvisible) {
			d();
			return;
		}
		let i = e.join(qv, t.session ? "tray-active-template.png" : "tray-template.png");
		if (a && o !== i) {
			let e = l.createFromPath(i);
			e.setTemplateImage(!0), a.setImage(e), o = i;
		} else if (!a) {
			let e = l.createFromPath(i);
			e.setTemplateImage(!0), a = new r(e), a.setToolTip("Cluely"), process.platform !== "darwin" && a.on("click", () => {
				Q.patchSharedState({
					showDashboard: !0,
					dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1
				});
			}), o = i;
		}
		let c = p(t);
		s && ye(s, c) || (a.setContextMenu(n.buildFromTemplate(f(c))), s = c);
	}
	t.update = u;
	function d() {
		a?.destroy(), a = null, o = null, s = null;
	}
	function f(e) {
		let t = {
			label: `${e.showChat ? "Hide" : "Show"} Cluely`,
			click: () => {
				let { showChat: e } = Q.getSharedState();
				Q.patchSharedState({ showChat: !e });
			}
		}, n = {
			label: e.isInvisible ? "Disable Invisibility" : "Enable Invisibility",
			click: () => {
				Q.patchSharedState({ isInvisible: !e.isInvisible });
			}
		}, r = {
			label: "View Sessions",
			click: () => {
				let e = Z.Dashboard.getWindow();
				e && (Z.navigate(e, { to: "/dashboard" }), Q.patchSharedState({
					showDashboard: !0,
					dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1
				}));
			}
		}, a = {
			label: "Preferences",
			click: () => {
				let e = Z.Dashboard.getWindow();
				e && (Z.navigate(e, {
					to: "/dashboard",
					search: { settings: "general" }
				}), Q.patchSharedState({
					showDashboard: !0,
					dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1
				}));
			}
		}, o = {
			label: "Start Listening",
			click: () => {
				Z.broadcastIpc("control-start-session");
			}
		}, s = {
			label: "Stop Listening",
			click: () => {
				Z.broadcastIpc("control-end-session");
			}
		}, c = {
			label: `Quit ${j.VITE_DESKTOP_PRODUCT_NAME}`,
			click: () => {
				i.quit();
			}
		}, l = { type: "separator" };
		return [
			e.hasSession ? null : o,
			e.isControlWindowShown ? t : null,
			e.isControlWindowShown ? n : null,
			l,
			r,
			a,
			l,
			e.hasSession ? s : null,
			c
		].filter((e) => e != null);
	}
	function p(e) {
		return {
			hasSession: e.session != null,
			showChat: e.showChat,
			isInvisible: e.isInvisible,
			isControlWindowShown: e.session != null || e.isAmbientEnabled
		};
	}
})(iy ||= {});
//#endregion
