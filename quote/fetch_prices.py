"""Snapshot AWS list prices (us-east-1, On-Demand, paid tier) into quote/prices.json.

Every unit price used by the quote comes from the AWS Price List API, together with
its SKU and the public offer file, so a reviewer can re-check any number.

Usage: .venv/Scripts/python quote/fetch_prices.py   (AWS profile "root")
"""
import datetime as dt
import json
import pathlib
import re

import boto3

REGION = "us-east-1"
OUT = pathlib.Path(__file__).with_name("prices.json")
OFFER = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{svc}/current/{region}/index.json"

P_BEDROCK = "https://aws.amazon.com/bedrock/pricing/"

# key: (service code, usagetype, description regex or None, pricing page, extra filters)
SPECS = {
    # LLM: regional (us.* inference profile) "standard" prices
    "haiku_in": ("AmazonBedrockFoundationModels", "USE1-MP:USE1_input_tokens_standard-Units", r"Haiku 5\.5", P_BEDROCK, {}),
    "haiku_out": ("AmazonBedrockFoundationModels", "USE1-MP:USE1_output_tokens_standard-Units", r"Haiku 5\.5", P_BEDROCK, {}),
    "haiku_cache_read": ("AmazonBedrockFoundationModels", "USE1-MP:USE1_cache_read_tokens_standard-Units", r"Haiku 5\.5", P_BEDROCK, {}),
    "haiku_cache_write": ("AmazonBedrockFoundationModels", "USE1-MP:USE1_cache_write_tokens_standard-Units", r"Haiku 5\.5", P_BEDROCK, {}),
    "sonnet_in": ("AmazonBedrockFoundationModels", "USE1-MP:USE1_input_tokens_standard-Units", r"Sonnet 5\.5", P_BEDROCK, {}),
    "sonnet_out": ("AmazonBedrockFoundationModels", "USE1-MP:USE1_output_tokens_standard-Units", r"Sonnet 5\.5", P_BEDROCK, {}),
    "sonnet_cache_read": ("AmazonBedrockFoundationModels", "USE1-MP:USE1_cache_read_tokens_standard-Units", r"Sonnet 5\.5", P_BEDROCK, {}),
    "sonnet_cache_write": ("AmazonBedrockFoundationModels", "USE1-MP:USE1_cache_write_tokens_standard-Units", r"Sonnet 5\.5", P_BEDROCK, {}),
    # text-to-image is only offered in us-west-2 (us-east-1 has editing models only)
    "image_core": ("AmazonBedrockFoundationModels", "USW2-MP:USW2_created_image_stable_image_core-Units", r"Stable Image Core", P_BEDROCK, {"regionCode": "us-west-2"}),
    "embed_titan_v2": ("AmazonBedrock", "USE1-TitanEmbeddingV2-Text-input-tokens", None, P_BEDROCK, {}),
    "embed_titan_v2_batch": ("AmazonBedrock", "USE1-TitanEmbeddingV2-Text-input-tokens-batch", None, P_BEDROCK, {}),
    "guard_prompt_attack": ("AmazonBedrock", "USE1-GuardrailChecks-PromptAttackCheckUnitsConsumed", None, P_BEDROCK, {}),
    "guard_pii": ("AmazonBedrock", "USE1-Guardrail-SensitiveInformationPolicyPaidUnitsConsumed", None, P_BEDROCK, {}),
    # Compute / edge
    "fargate_arm_vcpu_h": ("AmazonECS", "USE1-Fargate-ARM-vCPU-Hours:perCPU", None, "https://aws.amazon.com/fargate/pricing/", {}),
    "fargate_arm_gb_h": ("AmazonECS", "USE1-Fargate-ARM-GB-Hours", None, "https://aws.amazon.com/fargate/pricing/", {}),
    "lambda_arm_gb_s": ("AWSLambda", "Lambda-GB-Second-ARM", r"Tier-1|Tier 1|First", "https://aws.amazon.com/lambda/pricing/", {}),
    "lambda_arm_req": ("AWSLambda", "Request-ARM", None, "https://aws.amazon.com/lambda/pricing/", {}),
    "alb_h": ("AWSELB", "LoadBalancerUsage", r"Application", "https://aws.amazon.com/elasticloadbalancing/pricing/", {"productFamily": "Load Balancer-Application"}),
    "alb_lcu_h": ("AWSELB", "LCUUsage", r"Application", "https://aws.amazon.com/elasticloadbalancing/pricing/", {"productFamily": "Load Balancer-Application"}),
    "waf_acl": ("awswaf", "USE1-WebACLV2", None, "https://aws.amazon.com/waf/pricing/", {}),
    "waf_rule": ("awswaf", "USE1-RuleV2", None, "https://aws.amazon.com/waf/pricing/", {}),
    "waf_req": ("awswaf", "USE1-RequestV2-Tier0", None, "https://aws.amazon.com/waf/pricing/", {}),
    # Identity
    "cognito_enterprise_mau": ("AmazonCognito", "USE1-CognitoEnterpriseMAU", None, "https://aws.amazon.com/cognito/pricing/", {}),
    # Data
    "aurora_acu_h": ("AmazonRDS", "Aurora:ServerlessV2Usage", r"PostgreSQL", "https://aws.amazon.com/rds/aurora/pricing/", {"databaseEngine": "Aurora PostgreSQL"}),
    "aurora_storage_gb": ("AmazonRDS", "Aurora:StorageUsage", r"PostgreSQL", "https://aws.amazon.com/rds/aurora/pricing/", {"databaseEngine": "Aurora PostgreSQL"}),
    "aurora_io": ("AmazonRDS", "Aurora:StorageIOUsage", r"PostgreSQL", "https://aws.amazon.com/rds/aurora/pricing/", {"databaseEngine": "Aurora PostgreSQL"}),
    "aurora_backup_gb_usw2": ("AmazonRDS", "USW2-Aurora:BackupUsage", None, "https://aws.amazon.com/rds/aurora/pricing/", {"regionCode": "us-west-2", "databaseEngine": "Aurora PostgreSQL"}),
    "ddb_wru": ("AmazonDynamoDB", "WriteRequestUnits", None, "https://aws.amazon.com/dynamodb/pricing/on-demand/", {}),
    "ddb_rru": ("AmazonDynamoDB", "ReadRequestUnits", None, "https://aws.amazon.com/dynamodb/pricing/on-demand/", {}),
    "ddb_storage_gb": ("AmazonDynamoDB", "TimedStorage-ByteHrs", r"beyond", "https://aws.amazon.com/dynamodb/pricing/on-demand/", {}),
    "s3_std_gb": ("AmazonS3", "TimedStorage-ByteHrs", r"first 50 TB", "https://aws.amazon.com/s3/pricing/", {"storageClass": "General Purpose"}),
    "s3_int_fa_gb": ("AmazonS3", "TimedStorage-INT-FA-ByteHrs", r"first 50 TB", "https://aws.amazon.com/s3/pricing/", {}),
    "s3_int_ia_gb": ("AmazonS3", "TimedStorage-INT-IA-ByteHrs", None, "https://aws.amazon.com/s3/pricing/", {}),
    "s3_int_monitor_obj": ("AmazonS3", "Monitoring-Automation-INT", None, "https://aws.amazon.com/s3/pricing/", {}),
    "s3_gir_gb": ("AmazonS3", "TimedStorage-GIR-ByteHrs", None, "https://aws.amazon.com/s3/pricing/", {}),
    "s3_put": ("AmazonS3", "Requests-Tier1", None, "https://aws.amazon.com/s3/pricing/", {}),
    "s3_get": ("AmazonS3", "Requests-Tier2", None, "https://aws.amazon.com/s3/pricing/", {}),
    "sqs_req": ("AWSQueueService", "Requests-RBP", r"Tier1", "https://aws.amazon.com/sqs/pricing/", {}),
    "sfn_transition": ("AmazonStates", "USE1-StateTransition", None, "https://aws.amazon.com/step-functions/pricing/", {}),
    # Security
    "kms_key": ("awskms", "us-east-1-KMS-Keys", None, "https://aws.amazon.com/kms/pricing/", {}),
    "kms_req": ("awskms", "us-east-1-KMS-Requests", None, "https://aws.amazon.com/kms/pricing/", {}),
    "secret": ("AWSSecretsManager", "USE1-AWSSecretsManager-Secrets", None, "https://aws.amazon.com/secrets-manager/pricing/", {}),
    # Network
    "nat_h": ("AmazonEC2", "NatGateway-Hours", None, "https://aws.amazon.com/vpc/pricing/", {"productFamily": "NAT Gateway"}),
    "nat_gb": ("AmazonEC2", "NatGateway-Bytes", None, "https://aws.amazon.com/vpc/pricing/", {"productFamily": "NAT Gateway"}),
    "vpce_h": ("AmazonVPC", "USE1-VpcEndpoint-Hours", None, "https://aws.amazon.com/privatelink/pricing/", {}),
    "vpce_gb": ("AmazonVPC", "USE1-VpcEndpoint-Bytes", r"upto 1 PB", "https://aws.amazon.com/privatelink/pricing/", {}),
    "egress_gb": ("AWSDataTransfer", "DataTransfer-Out-Bytes", r"first 10 TB", "https://aws.amazon.com/ec2/pricing/on-demand/", {"regionCode": None, "fromRegionCode": "us-east-1", "transferType": "AWS Outbound"}),
    "xregion_gb": ("AWSDataTransfer", "USE1-USW2-AWS-Out-Bytes", None, "https://aws.amazon.com/ec2/pricing/on-demand/", {"regionCode": None, "fromRegionCode": "us-east-1", "toRegionCode": "us-west-2"}),
    # Observability / CI
    "cw_logs_ingest_gb": ("AmazonCloudWatch", "DataProcessing-Bytes", None, "https://aws.amazon.com/cloudwatch/pricing/", {}),
    "cw_logs_store_gb": ("AmazonCloudWatch", "TimedStorage-ByteHrs", None, "https://aws.amazon.com/cloudwatch/pricing/", {}),
    "cw_metric": ("AmazonCloudWatch", "CW:MetricMonitorUsage", r"first 10,000", "https://aws.amazon.com/cloudwatch/pricing/", {}),
    "cw_alarm": ("AmazonCloudWatch", "CW:AlarmMonitorUsage", None, "https://aws.amazon.com/cloudwatch/pricing/", {}),
    "xray_trace": ("AWSXRay", "USE1-XRay-TracesStored", None, "https://aws.amazon.com/xray/pricing/", {}),
    "ecr_gb": ("AmazonECR", "TimedStorage-ByteHrs", None, "https://aws.amazon.com/ecr/pricing/", {}),
    "codebuild_arm_small_min": ("CodeBuild", "USE1-Build-Min:ARM:g1.small", None, "https://aws.amazon.com/codebuild/pricing/", {}),
}


def fetch(pc, svc, usagetype, desc_re, extra):
    filters = {"regionCode": REGION, "usagetype": usagetype}
    filters.update(extra)
    F = [{"Type": "TERM_MATCH", "Field": k, "Value": v} for k, v in filters.items() if v is not None]
    hits = []
    for page in pc.get_paginator("get_products").paginate(ServiceCode=svc, Filters=F):
        for s in page["PriceList"]:
            p = json.loads(s)
            attrs = p["product"]["attributes"]
            for term in p["terms"].get("OnDemand", {}).values():
                for d in term["priceDimensions"].values():
                    text = d["description"] + " " + attrs.get("servicename", "")
                    if desc_re and not re.search(desc_re, text):
                        continue
                    usd = float(d["pricePerUnit"]["USD"])
                    if usd == 0:  # never quote zero-priced (free) dimensions
                        continue
                    hits.append({"usd": usd, "unit": d["unit"], "sku": p["product"]["sku"],
                                 "description": d["description"], "rate_code": d["rateCode"]})
    if len(hits) != 1:
        raise SystemExit(f"{svc}/{usagetype}/{desc_re}: expected 1 price, got {len(hits)}: {hits[:4]}")
    return hits[0]


def main():
    pc = boto3.Session().client("pricing", region_name="us-east-1")  # AWS_PROFILE=root locally
    out = {"fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "region": REGION, "prices": {}}
    for key, (svc, ut, desc_re, page, extra) in SPECS.items():
        h = fetch(pc, svc, ut, desc_re, extra)
        h.update({"service_code": svc, "usagetype": ut, "page": page,
                  "offer_file": OFFER.format(svc=svc, region=extra.get("regionCode") or REGION)})
        out["prices"][key] = h
        print(f"{key:24} {h['usd']:<14g} {h['unit']:<22} {h['sku']}")
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
