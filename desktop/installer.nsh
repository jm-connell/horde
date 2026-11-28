; Uninstalling asks whether Horde's own data should go too. Videos are never
; touched: the media folder is the user's. An update runs the old version's
; uninstaller as well, so the question is skipped then (isUpdated) and a silent
; uninstall keeps the data (/SD IDNO).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_DEFBUTTON2 "Also delete Horde's data on this computer (library database, settings, thumbnails)?$\r$\n$\r$\nYour videos are not deleted either way." /SD IDNO IDNO horde_keep_data
      RMDir /r "$LOCALAPPDATA\Horde"
    horde_keep_data:
  ${endIf}
!macroend
