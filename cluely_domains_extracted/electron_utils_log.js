//#region electron/utils/log.ts
var hy = gy("error", (e) => {
	Z.broadcastIpc("electron-main-error-log", { message: e.data.map(_y).join(" ") });
});
function gy(e, t) {
	return Object.assign(t, {
		level: e,
		transforms: []
	});
}
function _y(e) {
	if (e instanceof Error) return e.stack ?? e.message;
	if (typeof e == "object") try {
		return JSON.stringify(e);
	} catch {}
	return String(e);
}
!me && process.platform === "darwin" && !i.isInApplicationsFolder() && i.moveToApplicationsFolder(), i.requestSingleInstanceLock() || i.quit(), i.setName(j.VITE_DESKTOP_PRODUCT_NAME);
var vy = e.join(i.getPath("appData"), process.platform === "darwin" ? `${j.VITE_DESKTOP_SCHEME}-april22` : j.VITE_DESKTOP_SCHEME);
i.setPath("userData", vy), _.transports.ipc.level = !1, process.platform === "darwin" && (_.transports.file.resolvePathFn = ({ libraryDefaultDir: t }) => e.join(t, "..", j.VITE_DESKTOP_SCHEME, "main.log")), _.transports.forwardToRenderer = hy, _.initialize(), _.errorHandler.startCatching({ showDialog: !1 }), _.info("Writing logs to:", _.transports.file.getFile().path), i.whenReady().then(async () => {
	await Q.init(), ey.init(), py.init(), Xv.init(), Yv.init(), iy.init(), my.init(), dy.init(), ry.init(), ny.init(), Z.init(), sy.init(), oy.init(), ty.init(), Q.onFinishInit();
}).catch((e) => {
	_.error("Failed during Electron startup:", e), ey.requireErrorRestart();
});
//#endregion
