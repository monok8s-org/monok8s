from setuptools import setup, find_packages

setup(
    name="aws-monok8s",
    version="0.1.0",
    description="AWS CLI plugin for monok8s — cloud-native Kubernetes SaaS platform",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    license="Apache Software License 2.0",
    author="monok8s team",
    url="https://github.com/monok8s/monok8s",
    packages=find_packages(exclude=["tests*"]),
    install_requires=["awscli>=1.29"],
    package_data={"aws_monok8s": ["*.py"]},
    python_requires=">=3.8",
)
