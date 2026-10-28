//#region electron/domains/menu.ts
var my;
(function(e) {
	function t() {
		let e = n.buildFromTemplate([
			{
				role: "appMenu",
				submenu: [
					{ role: "about" },
					{ type: "separator" },
					{ role: "services" },
					{ type: "separator" },
					{
						label: "Hide Cluely",
						accelerator: "Cmd+H",
						click: () => {
							let e = Q.getSharedState();
							Z.areAppWindowsLoaded(e) ? r() : i.hide();
						}
					},
					{ role: "hideOthers" },
					{ role: "unhide" },
					{ type: "separator" },
					...j.VITE_IS_PROD === "true" ? [] : [{
						label: "Developer Tools",
						submenu: [
							{
								label: "Toggle DevTools: Auth",
								click: () => a(Z.Auth.getWindow(), { mode: "detach" })
							},
							{
								label: "Toggle DevTools: Onboarding",
								click: () => a(Z.Onboarding.getWindow(), { mode: "detach" })
							},
							{
								label: "Toggle DevTools: Control",
								click: () => a(Z.Control.getWindow(), { mode: "detach" })
							},
							{
								label: "Toggle DevTools: Chat",
								click: () => a(Z.Chat.getWindow(), { mode: "detach" })
							},
							{
								label: "Toggle DevTools: Dashboard",
								click: () => a(Z.Dashboard.getWindow())
							},
							{
								label: "Toggle DevTools: Notification",
								click: () => a(Z.MeetingNotification.getWindow(), { mode: "detach" })
							}
						]
					}, { type: "separator" }],
					{
						label: "Quit Cluely",
						accelerator: "Cmd+Q",
						click: () => {
							let e = Q.getSharedState();
							Z.areAppWindowsLoaded(e) ? r() : i.quit();
						}
					}
				]
			},
			{ role: "fileMenu" },
			{ role: "editMenu" }
		]);
		n.setApplicationMenu(e);
	}
	e.init = t;
	function r() {
		Q.patchSharedState({
			showChat: !1,
			showDashboard: !1
		}), i.hide();
	}
	function a(e, t) {
		e && (e.webContents.isDevToolsOpened() ? e.webContents.closeDevTools() : e.webContents.openDevTools(t));
	}
})(my ||= {});
//#endregion
