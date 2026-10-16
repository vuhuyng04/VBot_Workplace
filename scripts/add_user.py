"""Provision a VBot user (no self sign-up). Cognito e-mails a temporary password; the user sets
a new password and enrols TOTP MFA on first sign-in.

Usage: .venv/Scripts/python scripts/add_user.py email@company.com [department] [--admin]
"""
import sys

import boto3


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        raise SystemExit(__doc__)
    email, dept = args[0], (args[1] if len(args) > 1 else "default")
    idp = boto3.Session(region_name="us-east-1").client("cognito-idp")  # credentials: AWS_PROFILE locally
    pool = next(p["Id"] for p in idp.list_user_pools(MaxResults=20)["UserPools"] if p["Name"] == "vbot-mvp")
    try:
        idp.admin_create_user(UserPoolId=pool, Username=email, DesiredDeliveryMediums=["EMAIL"],
                              UserAttributes=[{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"},
                                              {"Name": "custom:department", "Value": dept}])
        print("created; invitation e-mail sent to", email)
    except idp.exceptions.UsernameExistsException:
        print("user exists:", email)
    for g in ["user"] + (["platform_admin"] if "--admin" in sys.argv else []):
        idp.admin_add_user_to_group(UserPoolId=pool, Username=email, GroupName=g)


if __name__ == "__main__":
    main()
