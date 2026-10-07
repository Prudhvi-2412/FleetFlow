param([string]$Profile = 'fleetflow-admin')

$ErrorActionPreference = 'Stop'
$awsCommand = Get-Command aws.exe -ErrorAction SilentlyContinue
$awsCli = if ($awsCommand) { $awsCommand.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\Amazon\AWSCLIV2\aws.exe' }
if (-not (Test-Path -LiteralPath $awsCli)) { throw 'AWS CLI was not found.' }

$identity = & $awsCli sts get-caller-identity --profile $Profile --query Arn --output text
if ($LASTEXITCODE -ne 0 -or $identity.Trim() -ne 'arn:aws:iam::213470585464:user/prudhvisairamk@gmail.com') {
  throw 'Sign in to the FleetFlow IAM administrator profile before creating the deploy role.'
}

$providerArn = 'arn:aws:iam::213470585464:oidc-provider/token.actions.githubusercontent.com'
$existing = & $awsCli iam list-open-id-connect-providers --profile $Profile --query 'OpenIDConnectProviderList[].Arn' --output text
if ($LASTEXITCODE -ne 0) { throw 'Could not list IAM OpenID Connect providers.' }
if (($existing -split '\s+') -notcontains $providerArn) {
  & $awsCli iam create-open-id-connect-provider --url 'https://token.actions.githubusercontent.com' --client-id-list 'sts.amazonaws.com' --profile $Profile | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the GitHub OpenID Connect provider.' }
}

& $awsCli cloudformation deploy --stack-name FleetFlowGitHubDeploy `
  --template-file (Join-Path $PSScriptRoot 'github-deploy-role.yaml') `
  --capabilities CAPABILITY_NAMED_IAM --region ap-south-2 --profile $Profile
if ($LASTEXITCODE -ne 0) { throw 'Could not create the GitHub deployment role.' }

$roleArn = & $awsCli cloudformation describe-stacks --stack-name FleetFlowGitHubDeploy `
  --region ap-south-2 --profile $Profile `
  --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or -not $roleArn -or $roleArn -eq 'None') { throw 'Could not read the GitHub deployment role ARN.' }

$githubCli = Get-Command gh.exe -ErrorAction SilentlyContinue
if ($githubCli) {
  & $githubCli.Source variable set FLEETFLOW_AWS_ROLE_ARN --body $roleArn --repo Prudhvi-2412/FleetFlow
  if ($LASTEXITCODE -eq 0) {
    Write-Host 'GitHub Actions deploy role is configured.'
    exit 0
  }
}

Write-Host "AWS role created: $roleArn"
Write-Host 'Add its ARN as the GitHub repository variable FLEETFLOW_AWS_ROLE_ARN, then push or merge to main.'
