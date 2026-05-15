from setuptools import setup, find_packages

VERSION = "0.1.0"

CLASSIFIERS = [
    "Development Status :: 4 - Beta",
    "Intended Audience :: Developers",
    "Intended Audience :: System Administrators",
    "Programming Language :: Python",
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3 :: Only",
    "License :: OSI Approved :: Apache Software License",
]

setup(
    name="monok8s",
    version=VERSION,
    description="Azure CLI extension for monok8s — cloud-native Kubernetes SaaS platform",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    license="Apache Software License 2.0",
    author="monok8s team",
    url="https://github.com/monok8s/monok8s",
    classifiers=CLASSIFIERS,
    packages=find_packages(exclude=["tests*"]),
    install_requires=[],  # azure-cli provides all required packages
    extras_require={},
    package_data={
        "azext_monok8s": ["*.py"],
    },
    entry_points={
        "azure_cli_command_modules": [
            "monok8s=azext_monok8s:Monok8sCommandsLoader",
        ],
    },
    python_requires=">=3.8",
)
