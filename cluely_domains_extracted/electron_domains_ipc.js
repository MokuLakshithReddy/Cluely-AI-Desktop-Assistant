//#region electron/domains/ipc.ts
var py;
(function(e) {
	function t() {
		$.on("quit-app", () => {
			i.quit();
		}), $.on("relaunch-app", () => {
			i.relaunch(), i.exit(0);
		}), $.on("reset-all-state", () => {
			Q.resetAllState();
		}), $.on("restart-to-update", () => {
			oy.restartToUpdate();
		}), $.on("open-dashboard-session", ({ sessionId: e, createdAt: t, openDashboard: n }) => {
			let r = Z.Dashboard.getWindow();
			r && (Z.navigate(r, {
				to: "/dashboard/sessions/$sessionId",
				params: { sessionId: e },
				search: { createdAt: t }
			}), n && Q.patchSharedState({
				showDashboard: !0,
				dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1
			}));
		}), $.on("open-dashboard-billing", () => {
			let e = Z.Dashboard.getWindow();
			e && (Z.navigate(e, {
				to: "/dashboard",
				search: { settings: "billing" }
			}), Q.patchSharedState({
				showDashboard: !0,
				dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1
			}));
		}), $.on("open-dashboard-modes", () => {
			let e = Z.Dashboard.getWindow();
			e && (Z.navigate(e, {
				to: "/dashboard",
				search: { showModes: !0 }
			}), Q.patchSharedState({
				showDashboard: !0,
				dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1
			}));
		}), $.on("open-dashboard-shortcuts", () => {
			let e = Z.Dashboard.getWindow();
			e && (Z.navigate(e, {
				to: "/dashboard",
				search: { settings: "shortcuts" }
			}), Q.patchSharedState({
				showDashboard: !0,
				dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1
			}));
		}), $.on("control-window-drag", ({ x: e, y: t }) => {
			Z.Control.setPosition({
				x: e,
				y: t
			});
		}), $.on("control-window-drag-end", () => {
			Z.normalizeControlAndChatWindowPosition();
		}), $.on("control-window-reset-position", () => {
			Z.Control.resetPosition(), Z.Chat.resetHeight();
		}), $.on("control-window-toggle-chat", () => {
			let e = Q.getSharedState(), t = !e.showChat;
			Q.patchSharedState({ showChat: t }), t && !e.isInvisible && Z.broadcastIpc("chat-focus-input"), t || Z.broadcastIpc("chat-blur-input");
		}), $.on("chat-window-resize", ({ height: e }) => {
			Z.Chat.setHeight(e);
		}), $.on("chat-window-reset-size", () => {
			Z.Chat.resetHeight();
		}), $.on("permissions-check", () => {
			dy.check();
		}), $.on("permissions-ask-for-access", ({ device: e }) => {
			dy.askForAccess(e);
		}), $.on("mac-open-system-settings", ({ device: e }) => {
			r(e);
		}), $.handle("get-shared-state", async () => Q.getSharedState()), $.handle("patch-shared-state", (e) => {
			Q.patchSharedState(e);
		}), $.handle("consume-last-deep-link-auth-token", () => ({ token: sy.consumeLastAuthToken() })), $.handle("check-for-updates", async () => ({ updateAvailable: await oy.checkForUpdates() })), $.handle("capture-screenshot", async () => await fy.capture());
	}
	e.init = t;
	function n(e) {
		switch (e) {
			case "microphone": return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
			case "screen": return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
			case "accessibility": return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
		}
	}
	async function r(e) {
		e === "screen" && await dy.askForAccess(e), await h.openExternal(n(e));
	}
})(py ||= {});
//#endregion
