# Private bucket for the app (document exports / backups / artifacts). The app reads its
# name from AWS_S3_BUCKET (wired into the task env). Suffix keeps the name globally unique.
resource "random_id" "bucket" {
  byte_length = 4
}

resource "aws_s3_bucket" "app" {
  bucket = "${local.name}-${random_id.bucket.hex}"
  tags   = { Name = "${local.name}-bucket" }
}

resource "aws_s3_bucket_public_access_block" "app" {
  bucket                  = aws_s3_bucket.app.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app" {
  bucket = aws_s3_bucket.app.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
