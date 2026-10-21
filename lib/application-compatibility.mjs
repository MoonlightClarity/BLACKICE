/** Reproducible observations, not an admission list or a promise for other PCs. */
export function applicationCompatibility() {
  return {
    testedAt:'2026-10-18',system:'Windows 10 · build 19045',
    scope:'Private, inactive Windows desktops with disposable documents and fresh test profiles. No foreground fallback was used.',
    apps:[
      {id:'notepad-classic',name:'Classic Notepad',version:'Windows 10',result:'verified',detail:'An owned window, captured frame and 24 accessible controls were observed. A semantic text edit and exact readback both passed.'},
      {id:'libreoffice-writer',name:'LibreOffice Writer',version:'25.8.6.2',result:'blocked',detail:'No owned application window appeared within 15 seconds. The launcher and its observed child processes exited; the private session closed.'},
      {id:'inkscape',name:'Inkscape',version:'1.4.2',result:'blocked',detail:'No owned window appeared within 15 seconds. The launcher exited with code 1 and its observed child exited; cleanup was confirmed.'},
      {id:'krita',name:'Krita',version:'5.2.16',result:'blocked',detail:'Two hidden owned windows appeared, but no visible application window within 15 seconds. The owned process exited during session cleanup.'},
      {id:'blender',name:'Blender',version:'4.5',result:'not_admitted',detail:'This installation reports a console executable type. The current GUI-only admission rule rejected it before launch.'},
    ],
    note:'These results describe the tested versions on this Windows build. They do not establish compatibility on every machine. Only applications in the available-app list can be started.',
  };
}
