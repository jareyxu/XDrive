"""Construct release member type regressions without executing archive content."""
import io
import shlex
import shutil
import tarfile


def replace_member_type(bundle, name, kind, target):
    with tarfile.open(bundle, "r:gz") as archive:
        members = [(member, archive.extractfile(member).read()) for member in archive.getmembers()]
    with tarfile.open(bundle, "w:gz") as archive:
        for member, contents in members:
            if member.name == name:
                member.type = kind
                member.size = 0
                member.linkname = str(target) if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
                archive.addfile(member)
            else:
                archive.addfile(member, io.BytesIO(contents))


def observe_extraction(root, commands):
    """Run real tar and record any extraction, including extraction that fails."""
    marker = root / "tar-extracted"
    tar = shutil.which("tar")
    wrapper = commands / "tar"
    wrapper.write_text("#!/usr/bin/env bash\nset -eu\n"
                       "for arg in \"$@\"; do\n"
                       "  case \"$arg\" in -x*|--extract) : > " + shlex.quote(str(marker)) + ";; esac\n"
                       "done\nexec " + shlex.quote(tar) + " \"$@\"\n")
    wrapper.chmod(0o755)
    return marker
