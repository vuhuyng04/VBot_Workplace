# VPC with three subnet tiers per AZ:
#   public   - ALB, NAT gateways
#   app      - ECS tasks, egress via NAT (only when nat_count > 0)
#   isolated - sandbox Lambda + Aurora: no route to Internet, S3/DynamoDB via gateway endpoints only
variable "name" { type = string }
variable "cidr" { type = string }
variable "az_count" { type = number }
variable "nat_count" {
  description = "0 = no NAT (idle), 1 = single NAT (MVP demo), az_count = HA (prod)"
  type        = number
}
variable "bedrock_endpoint" {
  description = "Interface endpoint for bedrock-runtime (private path to the model API, H1)"
  type        = bool
}

data "aws_availability_zones" "azs" { state = "available" }
data "aws_region" "current" {}

locals {
  azs = slice(data.aws_availability_zones.azs.names, 0, var.az_count)
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = var.name, component = "network" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name, component = "network" }
}

resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.cidr, 8, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-${count.index}", tier = "public", component = "network" }
}

resource "aws_subnet" "app" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 8, 10 + count.index)
  tags              = { Name = "${var.name}-app-${count.index}", tier = "app", component = "network" }
}

resource "aws_subnet" "isolated" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 8, 20 + count.index)
  tags              = { Name = "${var.name}-isolated-${count.index}", tier = "isolated", component = "network" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name}-public", component = "network" }
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = var.nat_count
  domain = "vpc"
  tags   = { Name = "${var.name}-nat-${count.index}", component = "network" }
}

resource "aws_nat_gateway" "this" {
  count         = var.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${var.name}-nat-${count.index}", component = "network" }
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "app" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id
  dynamic "route" {
    for_each = var.nat_count > 0 ? [1] : []
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = aws_nat_gateway.this[min(count.index, var.nat_count - 1)].id
    }
  }
  tags = { Name = "${var.name}-app-${count.index}", component = "network" }
}

resource "aws_route_table_association" "app" {
  count          = var.az_count
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-isolated", component = "network" }
}

resource "aws_route_table_association" "isolated" {
  count          = var.az_count
  subnet_id      = aws_subnet.isolated[count.index].id
  route_table_id = aws_route_table.isolated.id
}

# Gateway endpoints carry no hourly charge.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.app[*].id, [aws_route_table.isolated.id])
  tags              = { Name = "${var.name}-s3", component = "network" }
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.app[*].id
  tags              = { Name = "${var.name}-dynamodb", component = "network" }
}

resource "aws_security_group" "endpoints" {
  count       = var.bedrock_endpoint ? 1 : 0
  name        = "${var.name}-endpoints"
  description = "Interface endpoints, HTTPS from VPC only"
  vpc_id      = aws_vpc.this.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.cidr]
  }
  tags = { component = "network" }
}

resource "aws_vpc_endpoint" "bedrock_runtime" {
  count               = var.bedrock_endpoint ? 1 : 0
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.bedrock-runtime"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.app[*].id
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true
  tags                = { Name = "${var.name}-bedrock-runtime", component = "network" }
}

output "vpc_id" { value = aws_vpc.this.id }
output "cidr" { value = var.cidr }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "app_subnet_ids" { value = aws_subnet.app[*].id }
output "isolated_subnet_ids" { value = aws_subnet.isolated[*].id }
output "s3_prefix_list_id" { value = aws_vpc_endpoint.s3.prefix_list_id }
