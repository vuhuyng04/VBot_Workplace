"""Cognito JWT verification (SSO + MFA happen at the IdP / hosted login)."""
import time
from dataclasses import dataclass
from functools import lru_cache

import httpx
import jwt
from fastapi import Header, HTTPException

from .config import settings


@dataclass(frozen=True)
class User:
    user_id: str
    email: str
    groups: tuple[str, ...]
    department: str

    @property
    def is_admin(self) -> bool:
        return "platform_admin" in self.groups


@lru_cache(maxsize=1)
def _jwks(_bucket: int):
    s = settings()
    url = f"https://cognito-idp.{s.region}.amazonaws.com/{s.user_pool_id}/.well-known/jwks.json"
    return jwt.PyJWKSet.from_dict(httpx.get(url, timeout=5).json())


def _key(kid: str):
    for bucket_offset in (0, 1):  # refresh once if the key rotated
        ks = _jwks(int(time.time() // 3600) + bucket_offset)
        for k in ks.keys:
            if k.key_id == kid:
                return k.key
    raise HTTPException(401, "unknown signing key")


def verify(token: str) -> User:
    s = settings()
    try:
        kid = jwt.get_unverified_header(token)["kid"]
        claims = jwt.decode(token, _key(kid), algorithms=["RS256"],
                            issuer=f"https://cognito-idp.{s.region}.amazonaws.com/{s.user_pool_id}",
                            options={"verify_aud": False})
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"invalid token: {e}") from e
    if claims.get("token_use") != "id" or claims.get("aud") != s.client_id:
        raise HTTPException(401, "wrong token type or audience")
    return User(user_id=claims["sub"], email=claims.get("email", ""),
                groups=tuple(claims.get("cognito:groups", [])),
                department=claims.get("custom:department") or "default")


def current_user(authorization: str = Header(default="")) -> User:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing bearer token")
    return verify(authorization[7:])
