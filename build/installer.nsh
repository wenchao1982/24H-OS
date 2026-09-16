; 24H-OS 安装器定制（electron-builder nsis.include）
;
; 作用：把"默认中文"写进核心配置，让用户装完即是中文 —— 不依赖用户手动设置。
;
; 路径为什么是 $APPDATA\24H\hermes：
;   壳在运行时把 HERMES_HOME 指向 Electron 的 userData（Windows 上是 %APPDATA%\<productName>），
;   所以随包种子必须落在同一个位置，否则核心读不到。
;
; 幂等：已存在 config.yaml（用户自己配过）就不覆盖。

!macro customInstall
  ; 只写一次种子：display.language = zh（核心的静态消息/审批提示走这个键）
  IfFileExists "$APPDATA\24H\hermes\config.yaml" seed_done
    CreateDirectory "$APPDATA\24H\hermes"
    FileOpen $0 "$APPDATA\24H\hermes\config.yaml" w
    FileWrite $0 "display:$\r$\n"
    FileWrite $0 "  language: zh$\r$\n"
    FileClose $0
  seed_done:
!macroend

!macro customUnInstall
  ; 卸载时保留用户数据（会话/配置），只提示位置，避免误删用户资料。
  DetailPrint "24H 用户数据保留在 $APPDATA\24H（会话与配置未被删除）"
!macroend
