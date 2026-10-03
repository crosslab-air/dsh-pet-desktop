/**
 * standalone/app/preload-settings.cjs —— 「设置」窗口的 preload 桥
 * ============================================================================
 * 设置窗口是普通窗口（contextIsolation: true / nodeIntegration: false），
 * 只通过这里暴露的窄接口与主进程通信；主进程再直连本地服务与文件系统。
 *
 * 之所以不走 HTTP：设置窗口与本地服务**同在主进程**，走 IPC 少一层、也没有 CSP/端口问题。
 * ============================================================================
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsh', {
  /** 概览：余额 / 峰谷 / 密钥状态 / 偏好 / 快捷方式 / 日志尾部 */
  get: () => ipcRenderer.invoke('dsh:get'),
  /** 保存 API Key（写入 standalone/credential.json）并立即验证 */
  setKey: (key) => ipcRenderer.invoke('dsh:setKey', String(key || '')),
  /** 立即刷新一次余额 */
  refresh: () => ipcRenderer.invoke('dsh:refresh'),
  /** 设置界面缩放（0.6 ~ 1.6），重启桌宠后生效 */
  setScale: (scale) => ipcRenderer.invoke('dsh:setScale', Number(scale)),
  /** 开机自动启动开关 */
  setAutostart: (enabled) => ipcRenderer.invoke('dsh:setAutostart', !!enabled),
  /** 点击音效开关（立即生效，无需重启） */
  setSound: (enabled) => ipcRenderer.invoke('dsh:setSound', !!enabled),
  /** 点击音效音量 0~1（立即生效） */
  setVolume: (vol) => ipcRenderer.invoke('dsh:setVolume', Number(vol)),
  /** 音效组 duck | dingdong（立即生效） */
  setSoundSet: (set) => ipcRenderer.invoke('dsh:setSoundSet', String(set || '')),
  /** 在桌面创建（或修复）快捷方式 */
  createShortcut: () => ipcRenderer.invoke('dsh:createShortcut'),
  /** 打开数据目录 / 日志文件 / 配置文件 */
  openPath: (which) => ipcRenderer.invoke('dsh:openPath', String(which || '')),
  /** 重启桌宠（退出并重新拉起自己） */
  restart: () => ipcRenderer.invoke('dsh:restart'),
  /** 彻底退出桌宠程序 */
  quit: () => ipcRenderer.invoke('dsh:quit'),
});
