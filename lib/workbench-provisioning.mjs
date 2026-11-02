/**
 * Hyper-V Windows 11 generation-2 Workbench provisioning. No host reboot,
 * guest boot, new virtual switch, ISO download, or removal of existing VMs.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
const WORKBENCH_VM_NAME='BLACKICE-Workbench';

const bad = (message, code='WORKBENCH_PROVISION_INVALID', status=409) =>
  Object.assign(new Error(message), {code,status});
const utf16 = value => Buffer.from(value,'utf8').toString('base64');
const isoMinBytes=512*1024*1024;
const nativePath = value => typeof value==='string' && path.win32.isAbsolute(value) &&
  !value.includes('\0') && value.length<=3800;
export const WORKBENCH_VHDX_GIB=160;
export const WORKBENCH_INSTALL_MEDIA_MIN_BYTES=isoMinBytes;

/** Does not open or mount the user-provided ISO. */
export async function inspectWorkbenchMedia(mediaPath,{stat=fs.stat,open=fs.open}={}){
  if(!nativePath(mediaPath) || path.win32.extname(mediaPath).toLowerCase()!=='.iso')
    throw bad('Choose an existing absolute Windows .iso installation image.','WORKBENCH_MEDIA_PATH',400);
  const item=await stat(mediaPath).catch(()=>null);
  if(!item?.isFile() || !Number.isFinite(item.size) || item.size<isoMinBytes)
    throw bad('Windows ISO missing, unreadable or too small for a genuine installation image.','WORKBENCH_MEDIA_MISSING',400);
  let handle;
  try{
    handle=await open(mediaPath,'r');
    const signature=Buffer.alloc(5);
    const result=await handle.read(signature,0,signature.length,0x8001);
    if(result.bytesRead!==5||signature.toString('ascii')!=='CD001')
      throw bad('ISO9660 descriptor not found; verify the Windows installation image before using it.','WORKBENCH_MEDIA_SIGNATURE',400);
  } finally {await handle?.close()}
  return {path:mediaPath,size:item.size,kind:'windows-iso',checked:true};
}
const decode=(name,value)=>'$'+name+"=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+utf16(value)+"'))";
export function windowsWorkbenchProvisioningScript({isoPath,vmRoot,resources,switchName='Default Switch'}={}){
  if(!nativePath(isoPath)||!nativePath(vmRoot)||!/^[a-zA-Z0-9 ._()-]{3,90}$/.test(switchName))
    throw bad('VM provisioning needs validated absolute media and VM storage paths.');
  if(!resources||!Number.isSafeInteger(resources.startupMiB)||resources.startupMiB<2048||
    !Number.isSafeInteger(resources.maximumMiB)||resources.maximumMiB<resources.startupMiB||
    !Number.isSafeInteger(resources.cpuCount)||resources.cpuCount<1||resources.cpuCount>64)
    throw bad('Invalid Workbench VM resource allocation.');
  const disk=path.win32.join(vmRoot,'Workbench-Windows.vhdx');
  const lines=[
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "Import-Module Hyper-V -ErrorAction Stop",
    decode('iso',isoPath),decode('vmRoot',vmRoot),decode('disk',disk),decode('switchName',switchName),
    "$existing=Get-VM -Name '"+WORKBENCH_VM_NAME+"' -ErrorAction SilentlyContinue",
    "if($existing){throw 'The BLACKICE-Workbench VM already exists. Inspect it instead of creating a duplicate.'}",
    "if(Test-Path -LiteralPath $disk){throw 'Existing virtual disk must never be overwritten.'}",
    "$switch=Get-VMSwitch -Name $switchName -ErrorAction SilentlyContinue",
    "if(!$switch){throw 'Hyper-V Default Switch is absent. Configure an internal/NAT switch before provisioning.'}",
    "$media=Get-Item -LiteralPath $iso -ErrorAction Stop",
    "if(!$media -or $media.Length -lt "+isoMinBytes+"){throw 'Windows installation ISO is missing or changed.'}",
    "New-Item -ItemType Directory -Path $vmRoot -Force|Out-Null",
    "New-VM -Name '"+WORKBENCH_VM_NAME+"' -Generation 2 -MemoryStartupBytes "+resources.startupMiB+
      "MB -NewVHDPath $disk -NewVHDSizeBytes "+WORKBENCH_VHDX_GIB+
      "GB -Path $vmRoot -SwitchName $switch.Name -ErrorAction Stop | Out-Null",
    "Set-VMMemory -VMName '"+WORKBENCH_VM_NAME+"' -DynamicMemoryEnabled $true -MinimumBytes "+
      resources.minimumMiB+"MB -StartupBytes "+resources.startupMiB+"MB -MaximumBytes "+resources.maximumMiB+"MB -ErrorAction Stop",
    "Set-VMProcessor -VMName '"+WORKBENCH_VM_NAME+"' -Count "+resources.cpuCount+" -ErrorAction Stop",
    "Set-VMFirmware -VMName '"+WORKBENCH_VM_NAME+"' -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows -ErrorAction Stop",
    "Set-VMKeyProtector -VMName '"+WORKBENCH_VM_NAME+"' -NewLocalKeyProtector -ErrorAction Stop",
    "Enable-VMTPM -VMName '"+WORKBENCH_VM_NAME+"' -ErrorAction Stop",
    "Add-VMDvdDrive -VMName '"+WORKBENCH_VM_NAME+"' -Path $iso -ErrorAction Stop",
    "$dvd=Get-VMDvdDrive -VMName '"+WORKBENCH_VM_NAME+"' -ErrorAction Stop|Select-Object -First 1",
    "Set-VMFirmware -VMName '"+WORKBENCH_VM_NAME+"' -FirstBootDevice $dvd -ErrorAction Stop",
    "Set-VM -Name '"+WORKBENCH_VM_NAME+"' -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -CheckpointType ProductionOnly -ErrorAction Stop",
    "$service=Get-VMIntegrationService -VMName '"+WORKBENCH_VM_NAME+"' -Name 'Guest Service Interface' -ErrorAction SilentlyContinue",
    "if($service){Enable-VMIntegrationService -VMName '"+WORKBENCH_VM_NAME+"' -Name 'Guest Service Interface' -ErrorAction Stop}",
    "Write-Output 'WORKBENCH_VM_PROVISIONED_NOT_BOOTED'"
  ];
  return lines.join('\n');
}
