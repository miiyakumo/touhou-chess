"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_js_1 = require("./ui/app.js");
function boot() {
    try {
        new app_js_1.App();
    }
    catch (e) {
        const root = document.getElementById('app');
        if (root) {
            root.textContent = '页面初始化失败：' + (e instanceof Error ? e.message : String(e));
            root.setAttribute('role', 'alert');
        }
        console.error(e);
    }
}
if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', boot, { once: true });
else
    boot();

