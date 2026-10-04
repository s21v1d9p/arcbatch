// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract ArcBatch {
    uint256 public constant MAX_RECIPIENTS = 25;

    error InvalidBatch();
    error InvalidRecipient(uint256 index);
    error InvalidAmount(uint256 index);
    error IncorrectValue(uint256 expected, uint256 received);
    error TransferFailed(uint256 index);

    event Paid(address indexed sender, address indexed recipient, uint256 amount, uint256 index);

    function pay(address[] calldata recipients, uint256[] calldata amounts) external payable {
        uint256 count = recipients.length;
        if (count == 0 || count > MAX_RECIPIENTS || count != amounts.length) {
            revert InvalidBatch();
        }

        uint256 total;
        for (uint256 i; i < count; ++i) {
            if (recipients[i] == address(0) || recipients[i] == address(this)) {
                revert InvalidRecipient(i);
            }
            if (amounts[i] == 0) {
                revert InvalidAmount(i);
            }
            total += amounts[i];
        }
        if (total != msg.value) {
            revert IncorrectValue(total, msg.value);
        }

        for (uint256 i; i < count; ++i) {
            (bool success, ) = payable(recipients[i]).call{value: amounts[i]}("");
            if (!success) {
                revert TransferFailed(i);
            }
            emit Paid(msg.sender, recipients[i], amounts[i], i);
        }
    }
}
