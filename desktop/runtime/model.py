"""Serializable model objects shared by the runtime detector and host bridge."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class PlatformSnapshot:
    os: str
    architecture: str
    release: str
    machine: str
    python: str
    wsl: bool = False
    wsl_distributions: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "os": self.os,
            "architecture": self.architecture,
            "release": self.release,
            "machine": self.machine,
            "python": self.python,
            "wsl": self.wsl,
            "wsl_distributions": list(self.wsl_distributions),
        }


@dataclass
class ProbeResult:
    id: str
    status: str
    kind: str
    executable: Optional[str] = None
    version: Optional[str] = None
    summary: str = ""
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "id": self.id,
            "status": self.status,
            "kind": self.kind,
            "executable": self.executable,
            "version": self.version,
            "summary": self.summary,
        }
        if self.error:
            result["error"] = self.error
        return result


@dataclass
class CapabilityResult:
    id: str
    status: str
    execution: str
    summary: str
    version: Optional[str] = None
    executable: Optional[str] = None
    requires: List[str] = field(default_factory=list)
    remediation: Optional[str] = None
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "id": self.id,
            "status": self.status,
            "execution": self.execution,
            "summary": self.summary,
            "version": self.version,
            "executable": self.executable,
            "requires": list(self.requires),
            "remediation": self.remediation,
        }
        if self.details:
            result["details"] = dict(self.details)
        return result


@dataclass
class CapabilityMatrix:
    detected_at: str
    detector_version: str
    platform: PlatformSnapshot
    probes: List[ProbeResult]
    capabilities: List[CapabilityResult]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "protocol_version": "1.0",
            "detected_at": self.detected_at,
            "detector_version": self.detector_version,
            "platform": self.platform.to_dict(),
            "probes": [probe.to_dict() for probe in self.probes],
            "capabilities": [capability.to_dict() for capability in self.capabilities],
        }

    def supports(self, capability_id: str, allow_degraded: bool = False) -> bool:
        for capability in self.capabilities:
            if capability.id == capability_id:
                return capability.status == "available" or (allow_degraded and capability.status == "degraded")
        return False

    def capability(self, capability_id: str) -> Optional[CapabilityResult]:
        return next((item for item in self.capabilities if item.id == capability_id), None)
