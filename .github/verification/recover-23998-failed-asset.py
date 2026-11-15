"""Single-admission recovery of one failed GitHub draft release asset.

Controller only. This never rebuilds, retests, publishes, installs or restarts BLACKICE.
Each destructive stage is guarded by exact remote state and its predecessor receipt.
No mutation is automatically retried after any uncertain effect.
"""
import hashlib
import http.client
import json
import os
import pathlib
import re
import sys
import time
import urllib.parse
from datetime import datetime, timezone

REPO = "MoonlightClarity/BLACKICE"
SHA = "0101d3f88cc7f3f139394a1c943b899511668a90"
TAG = "v2.39.98"
DRAFT = 446260534
OLD_ASSET = 751904314
ORIGINAL_UPLOAD_JOB = "direct_ae1bc729ad2eb0f2dec9f9ee00a431134178e0532d5077e713610aae6880b8d2"
OLD_CREATED_UPDATED = "2026-11-15T18:20:37Z"
INSTALLER = "Blackice-2.39.98-Setup.exe"
INSTALLER_BYTES = 115669439
INSTALLER_SHA = "32e7e56cd32a755f5edb1395892c806b2761e408e84c8cb5ebcede24ce147ce8"
MANIFEST_SHA = "77fb948f6abdee137c6a9e0fe0ad39e28b8404c28a6ba0265ba34652c73b73fe"
FINGERPRINT = "9a7287d06dcbc1bbb0cf23cdf26d3d0d0c61839993c91ed6fb868556d3c205c6"
BUILD_RUN = 43732981837
BUILD_ARTIFACT = 14169143495
BUILD_CONTROLLER = "b40e71d61d8da7b20a4c62fc41c6e1a91270a581"
EXPECTED_SMALL = {
  "blackice-public-release.json": (751886420,564,"77fb948f6abdee137c6a9e0fe0ad39e28b8404c28a6ba0265ba34652c73b73fe"),
  "SHA256SUMS.txt": (751889054,190,"fbb6f068213886bf4d42c21e5f4b0b0d76edbe59015d2c71e1a43c9c407267e9"),
  "Read.me.txt": (751890725,482,"2d229953c8a67795a0a9e84eff596d6cef539b5605d005cfda129b357baa0768"),
}
ROOT = pathlib.Path.cwd()
EVIDENCE = ROOT / "recovery-evidence"
ORIGINAL = ROOT / "original-build"
TOKEN = os.environ.get("GH_TOKEN","")

def insist(value, why):
    if not value: raise RuntimeError(why)
def now():
    return datetime.now(timezone.utc).isoformat()
def fingerprint_file(file):
    size=0
    h=hashlib.sha256()
    with open(file,"rb") as f:
        for block in iter(lambda:f.read(1024*1024),b""):
            size+=len(block)
            h.update(block)
    return size,h.hexdigest()
def save(name, data):
    EVIDENCE.mkdir(parents=True,exist_ok=True)
    p=EVIDENCE/name
    with open(p,"x",encoding="utf-8") as f:
        json.dump({"format":1,"controllerRunId":os.environ.get("GITHUB_RUN_ID"),
                   "runAttempt":os.environ.get("GITHUB_RUN_ATTEMPT"),
                   "atUtc":now(),**data},f,indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    print("RECEIPT",name,flush=True)
def prior(name):
    with open(EVIDENCE/name,encoding="utf-8") as f:return json.load(f)
def metadata(method,path,timeout=30):
    insist(TOKEN and len(TOKEN)>15,"Missing GitHub Actions token")
    c=http.client.HTTPSConnection("api.github.com",timeout=timeout)
    headers={"Authorization":"Bearer "+TOKEN,"Accept":"application/vnd.github+json",
       "X-GitHub-Api-Version":"2022-11-28","User-Agent":"BLACKICE-23998-single-asset-recovery"}
    try:
        c.request(method,path,headers=headers)
        r=c.getresponse()
        status=r.status
        data=r.read(2*1024*1024)
    finally:
        c.close()
    try: obj=json.loads(data) if data else None
    except ValueError:obj={"unparsedResponseBytes":len(data)}
    return status,obj
def get(path):
    code,value=metadata("GET","/repos/"+REPO+path)
    insist(code==200,f"Read-only GitHub API failed with {code}: {path}")
    return value
def check_run_identity():
    insist(os.environ.get("GITHUB_RUN_ATTEMPT")=="1","Retry attempt not authorized")
    insist(os.environ.get("GITHUB_REF")=="refs/heads/codex/release23998-starter-recovery-20261115","Wrong controller branch")
    insist(os.environ.get("GITHUB_SHA") and os.environ["GITHUB_SHA"]!=SHA,"Source/controller identities conflated")
    insist(os.environ.get("GITHUB_REPOSITORY")==REPO,"Unexpected GitHub repository")
    insist(os.environ.get("GITHUB_RUN_ID","").isdigit(),"No durable CI run identity")
def check_small(items):
    by_name={x["name"]:x for x in items if x["name"] in EXPECTED_SMALL}
    insist(len(by_name)==3,"Missing one of the three preserved small assets")
    for name,(id_,length,sha) in EXPECTED_SMALL.items():
        obj=by_name[name]
        insist(obj.get("id")==id_ and obj.get("size")==length and
          obj.get("digest")=="sha256:"+sha and obj.get("state")=="uploaded",
          "Protected small asset metadata changed: "+name)
    insist(len([x for x in items if x["id"]!=OLD_ASSET and x["name"] not in EXPECTED_SMALL and x["name"]!=INSTALLER])==0,
      "Unexpected additional release asset")
def state():
    main=get("/git/ref/heads/main")
    tag=get("/git/ref/tags/"+TAG)
    rel=get("/releases/"+str(DRAFT))
    items=get("/releases/"+str(DRAFT)+"/assets?per_page=100")
    insist(main["object"]["sha"]==SHA,"main changed; recovery blocked")
    insist(tag["object"]["type"]=="commit" and tag["object"]["sha"]==SHA,"Existing release tag identity changed")
    insist(rel["id"]==DRAFT and rel["tag_name"]==TAG and rel["target_commitish"]==SHA
        and rel["draft"] is True and rel["published_at"] is None,"Draft publication/target state changed")
    insist(rel["upload_url"].split("{",1)[0]==
       "https://uploads.github.com/repos/"+REPO+"/releases/"+str(DRAFT)+"/assets",
       "Unexpected GitHub returned release upload URL")
    check_small(items)
    return rel,items
def original_files():
    names=sorted(p.name for p in ORIGINAL.iterdir() if p.is_file())
    insist(names==sorted([INSTALLER,"blackice-public-release.json","SHA256SUMS.txt","Read me.txt"]),
       "Original artifact download file set changed")
    size,sha=fingerprint_file(ORIGINAL/INSTALLER)
    insist((size,sha)==(INSTALLER_BYTES,INSTALLER_SHA),"Original installer bytes changed")
    mbytes=(ORIGINAL/"blackice-public-release.json").read_bytes()
    insist(hashlib.sha256(mbytes).hexdigest()==MANIFEST_SHA and len(mbytes)==564,
       "Original manifest bytes changed")
    manifest=json.loads(mbytes)
    insist(manifest["version"]=="2.39.98" and manifest["appFingerprint"]==FINGERPRINT
       and manifest["artifact"]=={"name":INSTALLER,"size":INSTALLER_BYTES,"sha256":INSTALLER_SHA}
       and manifest["signing"]["status"]=="unsigned" and manifest["signing"]["publisherVerified"] is False
       and manifest["published"] is False,"Original installer manifest has different source/signing identity")
    checks=set((ORIGINAL/"SHA256SUMS.txt").read_text("utf-8").splitlines())
    insist(checks=={INSTALLER_SHA+"  "+INSTALLER,MANIFEST_SHA+"  blackice-public-release.json"},
       "Original source build SHA256SUMS bytes mismatch")
    return size,sha
def do_preflight():
    check_run_identity()
    insist(not (EVIDENCE/"deletion-intent.json").exists()
       and not (EVIDENCE/"upload-intent.json").exists(),"Recovery already started")
    size,sha=original_files()
    original=get("/actions/runs/"+str(BUILD_RUN))
    insist(original["status"]=="completed" and original["conclusion"]=="success"
       and original["head_sha"]==BUILD_CONTROLLER,"Original build run state/identity differs")
    artifact=get("/actions/artifacts/"+str(BUILD_ARTIFACT))
    insist(artifact["id"]==BUILD_ARTIFACT and artifact["name"]==
        "blackice-23998-windows-candidate-NOT-PUBLISHED"
        and artifact["size_in_bytes"]==115652656 and not artifact["expired"]
        and artifact["workflow_run"]["id"]==BUILD_RUN,
        "Original build artifact metadata is not the approved original")
    rel,items=state()
    matches=[x for x in items if x["id"]==OLD_ASSET or x["name"]==INSTALLER]
    insist(len(matches)==1,"Failed installer asset missing/duplicated; stop without mutation")
    failed=matches[0]
    insist(failed["id"]==OLD_ASSET and failed["name"]==INSTALLER and
        failed["state"]=="starter" and failed["digest"] is None and
        failed["size"]==INSTALLER_BYTES and
        failed["updated_at"]==OLD_CREATED_UPDATED,
        "Failed installer asset settled or changed; stop")
    asset=get("/releases/assets/"+str(OLD_ASSET))
    insist(asset["id"]==OLD_ASSET and asset["state"]=="starter"
        and asset["digest"] is None and asset["size"]==INSTALLER_BYTES
        and asset["updated_at"]==OLD_CREATED_UPDATED,
        "Original starter asset changed on independent GET")
    save("preflight.json",{"state":"passed","action":"read-only-check-original-failed-asset",
       "sourceCommit":SHA,"mainTagRelease":"exact","draftReleaseId":DRAFT,
       "failedInstallerAsset":OLD_ASSET,"failedAssetState":"starter",
       "failedAssetDigest":None,"failedAssetUpdatedAt":OLD_CREATED_UPDATED,
       "originalUploadJobId":ORIGINAL_UPLOAD_JOB,
       "originalUploadJobState":"terminal-failed-with-possible-effects-confirmed-by-owner-prior-to-admission",
       "originalBuildRun":BUILD_RUN,"originalBuildArtifactId":BUILD_ARTIFACT,
       "installerName":INSTALLER,"installerBytes":size,"installerSha256":sha,
       "smallAssets":{x["name"]:{"id":x["id"],"sha256":x["digest"]} for x in items if x["name"] in EXPECTED_SMALL},
       "newBuildOrTest":False,"publicationAuthorized":False})
    print("ORIGINAL_STARTER_PREFLIGHT_PASSED",OLD_ASSET,"sha",sha,flush=True)

def do_delete():
    check_run_identity()
    insist(prior("preflight.json")["state"]=="passed","Predelete receipt missing/failed")
    original_files()
    rel,items=state()
    matches=[x for x in items if x["id"]==OLD_ASSET or x["name"]==INSTALLER]
    insist(len(matches)==1 and matches[0]["id"]==OLD_ASSET
       and matches[0]["state"]=="starter"
       and matches[0]["digest"] is None
       and matches[0]["updated_at"]==OLD_CREATED_UPDATED,
       "Failed original asset changed before deletion; stop")
    code,obj=metadata("GET","/repos/"+REPO+"/releases/assets/"+str(OLD_ASSET))
    insist(code==200 and obj.get("id")==OLD_ASSET and obj.get("state")=="starter" and obj.get("digest") is None,
      "Failed installer no longer matches delete target")
    save("deletion-intent.json",{"target":"failed-starter-asset-only","assetId":OLD_ASSET,
       "expectedState":"starter","expectedDigest":None,"expectedReleaseId":DRAFT,
       "requestIdentity":"ci:"+os.environ["GITHUB_RUN_ID"]+":1:delete:"+str(OLD_ASSET),
       "noRetries":True})
    try:
        code,obj=metadata("DELETE","/repos/"+REPO+"/releases/assets/"+str(OLD_ASSET),timeout=60)
        insist(code==204,f"Delete unconfirmed HTTP {code}: no automatic retry")
        save("deletion-result.json",{"state":"confirmed-204","deletedOnlyAssetId":OLD_ASSET,
             "httpStatus":code,"noOtherAssetMutated":True})
        print("ORIGINAL_STARTER_DELETE_CONFIRMED",OLD_ASSET,"http",code,flush=True)
    except Exception as e:
        save("deletion-uncertain.json",{"state":"uncertain-stop-no-retry","assetId":OLD_ASSET,
            "errorType":type(e).__name__,"error":str(e)[:300]})
        raise

def do_absence():
    insist(prior("deletion-result.json")["httpStatus"]==204,"No prior 204 deletion")
    state_ok=False
    for index in range(10):
        rel,items=state()
        code,_=metadata("GET","/repos/"+REPO+"/releases/assets/"+str(OLD_ASSET))
        absent=code==404 and all(x["id"]!=OLD_ASSET and x["name"]!=INSTALLER for x in items)
        if absent:
            state_ok=True
            break
        if index<9:time.sleep(3)
    insist(state_ok,"Deleted starter not consistently absent; no upload authorized")
    save("deletion-absent.json",{"state":"confirmed-absent-in-both-id-get-and-list",
      "originalAssetId":OLD_ASSET,"idLookupStatus":404,
      "draftId":DRAFT,"tag":TAG,"main":SHA,"smallAssetsStillExact":True})
    print("OLD_FAILED_ASSET_ABSENCE_CONFIRMED",OLD_ASSET,flush=True)

def do_upload():
    check_run_identity()
    insist(prior("deletion-absent.json")["state"]=="confirmed-absent-in-both-id-get-and-list",
        "Deletion absence not established")
    original_files()
    rel,items=state()
    code,_=metadata("GET","/repos/"+REPO+"/releases/assets/"+str(OLD_ASSET))
    insist(code==404 and all(x["name"]!=INSTALLER for x in items),
         "Installer already exists or failed original resurrected: do not upload")
    url=urllib.parse.urlsplit(rel["upload_url"].split("{",1)[0])
    insist(url.scheme=="https" and url.netloc=="uploads.github.com"
      and url.path=="/repos/"+REPO+"/releases/"+str(DRAFT)+"/assets",
      "GitHub release returned a different upload endpoint")
    urlpath=url.path+"?"+urllib.parse.urlencode({"name":INSTALLER})
    identity="ci:"+os.environ["GITHUB_RUN_ID"]+":1:upload:original:"+str(BUILD_ARTIFACT)
    save("upload-intent.json",{"state":"one-POST-admitted","requestIdentity":identity,
      "uploadUrlSource":"existing-draft-446260534","assetName":INSTALLER,
      "sourceBuildArtifact":BUILD_ARTIFACT,"originalBytes":INSTALLER_BYTES,
      "originalSha256":INSTALLER_SHA,"originalFailedAssetDeleted":OLD_ASSET,
      "contentLength":INSTALLER_BYTES,"httpTimeoutSeconds":720,"automaticRetry":False})
    conn=http.client.HTTPSConnection(url.netloc,timeout=720,blocksize=1024*1024)
    headers={"Authorization":"Bearer "+TOKEN,"Accept":"application/vnd.github+json",
        "X-GitHub-Api-Version":"2022-11-28","User-Agent":"BLACKICE-23998-single-asset-recovery",
        "Content-Type":"application/octet-stream","Content-Length":str(INSTALLER_BYTES)}
    try:
        with open(ORIGINAL/INSTALLER,"rb") as src:
            conn.request("POST",urlpath,body=src,headers=headers)
            response=conn.getresponse()
            code=response.status
            raw=response.read(1024*1024)
        try:obj=json.loads(raw) if raw else {}
        except ValueError: obj={"unparsedResponseBytes":len(raw)}
        if code!=201:
            save("upload-uncertain.json",{"state":"unconfirmed-stop-no-retry",
                "httpStatus":code,"response":str(obj)[:500],"requestIdentity":identity})
            raise RuntimeError("Single asset POST failed or uncertain with HTTP "+str(code))
        save("upload-response.json",{"state":"post-reported-201",
            "httpStatus":code,"assetId":obj.get("id"),"name":obj.get("name"),
            "bytes":obj.get("size"),"githubState":obj.get("state"),
            "githubDigest":obj.get("digest"),"requestIdentity":identity})
        insist(obj.get("name")==INSTALLER and obj.get("size")==INSTALLER_BYTES and
               isinstance(obj.get("id"),int) and obj["id"]!=OLD_ASSET,
               "Upload response identity mismatch; do not repeat")
        print("SINGLE_INSTALLER_POST_RETURNED_201",obj["id"],obj.get("state"),obj.get("digest"),flush=True)
    except Exception as e:
        if not (EVIDENCE/"upload-response.json").exists() and not (EVIDENCE/"upload-uncertain.json").exists():
            save("upload-uncertain.json",{"state":"uncertain-stop-no-retry",
                "requestIdentity":identity,"errorType":type(e).__name__,
                "error":str(e)[:250]})
        raise
    finally:
        conn.close()

def do_uploaded():
    response=prior("upload-response.json")
    insist(response["httpStatus"]==201 and response["name"]==INSTALLER and response["bytes"]==INSTALLER_BYTES,
           "Upload 201 response missing or changed")
    id_=response["assetId"]
    insist(isinstance(id_,int) and id_!=OLD_ASSET,"Invalid replacement asset ID")
    for i in range(24):
        rel,items=state()
        code,old=metadata("GET","/repos/"+REPO+"/releases/assets/"+str(OLD_ASSET))
        insist(code==404,"Old starter asset reappeared after upload")
        matches=[x for x in items if x["name"]==INSTALLER]
        insist(len(matches)==1 and matches[0]["id"]==id_,"Unexpected installer duplication")
        a=get("/releases/assets/"+str(id_))
        if a.get("state")=="uploaded" and a.get("digest")=="sha256:"+INSTALLER_SHA and a.get("size")==INSTALLER_BYTES:
            save("uploaded-asset.json",{"state":"uploaded-and-exact-digest",
               "assetId":id_,"releaseId":DRAFT,"name":a["name"],
               "bytes":a["size"],"githubDigest":a["digest"],
               "originalStarterIdAbsent":OLD_ASSET,
               "draftUnpublished":True,"smallAssetsPreserved":True})
            print("NEW_INSTALLER_ASSET_UPLOADED_DIGEST_VERIFIED",id_,a["digest"],flush=True)
            return
        if i<23:time.sleep(4)
    save("upload-uncertain-metadata.json",{"state":"did-not-settle-no-retry","assetId":id_,
        "expectedDigest":"sha256:"+INSTALLER_SHA,"expectedBytes":INSTALLER_BYTES})
    raise RuntimeError("Uploaded asset did not settle with exact size/digest; no retry")

def independent_download(id_,out):
    # Authenticated release asset binary read; explicitly handle CDN redirect without forwarding credentials.
    conn=http.client.HTTPSConnection("api.github.com",timeout=60)
    headers={"Authorization":"Bearer "+TOKEN,"Accept":"application/octet-stream",
      "User-Agent":"BLACKICE-23998-single-asset-recovery","X-GitHub-Api-Version":"2022-11-28"}
    conn.request("GET","/repos/"+REPO+"/releases/assets/"+str(id_),headers=headers)
    r=conn.getresponse()
    if r.status in (301,302,303,307,308):
        target=urllib.parse.urlsplit(r.getheader("Location") or "")
        insist(target.scheme=="https" and (target.hostname or "").endswith((".blob.core.windows.net",".githubusercontent.com",".github.com")),
           "Unexpected authenticated release asset CDN host")
        r.read();conn.close()
        conn=http.client.HTTPSConnection(target.netloc,timeout=150)
        path=target.path+("?"+target.query if target.query else "")
        conn.request("GET",path,headers={"User-Agent":"BLACKICE-23998-single-asset-recovery"})
        r=conn.getresponse()
    insist(r.status==200,"Independent authenticated asset download failed HTTP "+str(r.status))
    insist("json" not in (r.getheader("Content-Type") or ""), "Asset GET returned metadata JSON, not bytes")
    length=0; sha=hashlib.sha256()
    with open(out,"xb") as f:
        while True:
            buf=r.read(1024*1024)
            if not buf:break
            length+=len(buf);sha.update(buf);f.write(buf)
        f.flush();os.fsync(f.fileno())
    conn.close()
    return length,sha.hexdigest()

def do_download():
    verified=prior("uploaded-asset.json")
    id_=verified["assetId"]
    rel,items=state()
    matches=[x for x in items if x["name"]==INSTALLER]
    insist(len(matches)==1 and matches[0]["id"]==id_ and matches[0]["state"]=="uploaded"
          and matches[0]["digest"]=="sha256:"+INSTALLER_SHA,
          "Installer metadata changed before independent download")
    target=ROOT/"independent-downloaded-installer"/INSTALLER
    target.parent.mkdir(parents=True,exist_ok=True)
    insist(not target.exists(),"Independent download already exists; do not overwrite")
    length,sha=independent_download(id_,target)
    insist((length,sha)==(INSTALLER_BYTES,INSTALLER_SHA),
           "Independent public release asset download bytes/hash mismatch")
    save("independent-download.json",{"state":"original-verified-by-independent-read-only-download",
      "assetId":id_,"releaseId":DRAFT,"bytes":length,"sha256":sha,
      "originalBuildArtifact":BUILD_ARTIFACT,"originalStarterRemoved":OLD_ASSET,
      "releaseRemainsDraft":True,"originalManifestMatches":True,"smallAssetsPreserved":True})
    print("UPLOADED_ASSET_INDEPENDENT_DOWNLOAD_VERIFIED",id_,length,sha,flush=True)

def do_terminal():
    try:
        d=prior("independent-download.json")
        u=prior("uploaded-asset.json")
        delete=prior("deletion-result.json")
        insist(d["sha256"]==INSTALLER_SHA and u["assetId"]==d["assetId"] and delete["httpStatus"]==204,
               "Required successful recovery stages missing")
        rel,items=state()
        insist(rel["draft"] is True and rel["published_at"] is None,"Release unexpectedly published")
        save("terminal-recovery.json",{"state":"recovered-original-installer-only-DRAFT-NOT-PUBLISHED",
           "originalFailedAssetId":OLD_ASSET,"originalFailedAssetDeleted":True,
           "newInstallerAssetId":u["assetId"],"installerBytes":INSTALLER_BYTES,
           "installerSha256":INSTALLER_SHA,"independentDownloadVerified":True,
           "originalManifestSha256":MANIFEST_SHA,"tag":TAG,"sourceCommit":SHA,
           "draftReleaseId":DRAFT,"published":False,"testsRerun":False,
           "installerRebuilt":False,"appInstalled":False,"appRestarted":False,
           "rootPublicationGateOutstanding":True})
        print("RECOVERY_TERMINAL_SUCCESS_DRAFT_ONLY",u["assetId"],flush=True)
    except Exception as e:
        if not (EVIDENCE/"terminal-recovery.json").exists():
            save("terminal-recovery.json",{"state":"INCOMPLETE_NO_AUTOMATIC_RETRY",
               "errorType":type(e).__name__,"error":str(e)[:250],
               "draftId":DRAFT,"originalAssetId":OLD_ASSET,"publicationPerformed":False})
        raise

def main():
    phases={"preflight":do_preflight,"delete":do_delete,"absence":do_absence,
         "upload":do_upload,"uploaded":do_uploaded,"download":do_download,"terminal":do_terminal}
    insist(len(sys.argv)==2 and sys.argv[1] in phases,"Choose one bounded recovery phase")
    check_run_identity()
    phases[sys.argv[1]]()

if __name__=="__main__":
    main()
