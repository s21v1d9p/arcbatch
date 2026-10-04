// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IArcBatch {
    function pay(address[] calldata recipients, uint256[] calldata amounts) external payable;
}

contract ReenterFunds {
    IArcBatch private immutable batch;
    address private immutable recipient;
    bool private entered;

    constructor(address batchAddress, address recipientAddress) {
        batch = IArcBatch(batchAddress);
        recipient = recipientAddress;
    }

    receive() external payable {
        if (entered) return;
        entered = true;
        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;
        batch.pay{value: 1}(recipients, amounts);
    }
}
