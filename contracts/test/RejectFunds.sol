// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract RejectFunds {
    receive() external payable {
        revert("no funds accepted");
    }
}
