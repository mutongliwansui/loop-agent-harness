; ============================================================================
; LoopAgent 自定义 NSIS 脚本（由 desktop/package.json 的 nsis.include 引用）
;
; 背景：安装包改用「向导式」（oneClick: false）以支持自选安装目录后，
; assisted 模式会在欢迎页之后插入一个「安装模式选择页」——
;   ① 为所有用户安装（写 Program Files，需提权）
;   ② 仅为我安装（写 %LOCALAPPDATA%，无需提权）
; 现场用户多为非管理员账户，且是非技术用户：这一页对他们既是无效信息，
; 又存在误选「所有用户」直接失败的入口。
;
; 做法：electron-builder 的 multiUserUi.nsh 在渲染该页前会执行
;   !ifmacrodef customInstallmode
;     !insertmacro customInstallMode
;   !endif
; 并紧接着判断 $isForceCurrentInstall == "1" 时直接
;   !insertmacro setInstallModePerUser
;   Abort
; 即「强制 per-user 并跳过本页」。本文件只需定义该宏。
;
; 注意：宏名大小写在 NSIS 中不敏感，multiUserUi.nsh 里写的是
; customInstallmode（小写 m），此处用 customInstallMode 同样能命中。
;
; 配合 package.json 的 allowElevation: false：即使本宏因故失效，
; 「为所有用户安装」单选项也会被置灰（附 "(must run as admin)" 文案）而无法选中，
; 不会把 UAC 提权弹窗重新引回来。两层防护，任一层生效都不会装不上。
; ============================================================================

!macro customInstallMode
  ; 1 = 强制当前用户（per-user）安装；multiUserUi.nsh 据此跳过安装模式选择页
  StrCpy $isForceCurrentInstall "1"
!macroend
