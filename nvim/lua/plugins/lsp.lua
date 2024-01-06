return {
	{
		"williamboman/mason.nvim",
		config = function()
			require("mason").setup()
		end,
	},
	{
		"williamboman/mason-lspconfig.nvim",
		config = function()
			require("mason-lspconfig").setup({
				ensure_installed = {
					"lua_ls",
					"tsserver",
					"pyright",
				},
			})
		end,
	},
	{
		"neovim/nvim-lspconfig",
		dependencies = {
			{
				"j-hui/fidget.nvim",
				opts = {},
			},
			"folke/neodev.nvim",
		},
		config = function()
			require("neodev").setup()
			local lspconfig = require("lspconfig")

			local capabilities = vim.lsp.protocol.make_client_capabilities()
			capabilities = require("cmp_nvim_lsp").default_capabilities()

			lspconfig.pyright.setup({
				capabilities = capabilities,
				settings = {
					python = {
						analysis = {
							useLibraryCodeForTypes = false,
							typeCheckingMode = "off",
						},
					},
				},
			})
			lspconfig.tsserver.setup({
				capabilities = capabilities,
			})
			lspconfig.lua_ls.setup({
				capabilities = capabilities,
			})

			vim.keymap.set("n", "K", vim.lsp.buf.hover, {})
			vim.keymap.set("n", "<leader>gd", vim.lsp.buf.definition, {})
			vim.keymap.set("n", "<leader>gr", vim.lsp.buf.references, {})
			vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename, {})
			vim.keymap.set({ "n", "v" }, "<leader>ca", vim.lsp.buf.code_action, {})

			vim.o.updatetime = 250
			vim.api.nvim_create_autocmd({ "CursorHold", "CursorHoldI" }, {
				group = vim.api.nvim_create_augroup("float_diagnostic", { clear = true }),
				callback = function()
					vim.diagnostic.open_float(nil, { focus = false })
				end,
			})
		end,
	},
	{
		"jay-babu/mason-null-ls.nvim",
		event = { "BufReadPre", "BufNewFile" },
		dependencies = {
			"nvimtools/none-ls.nvim",
		},
		config = function()
			local null_ls = require("null-ls")
			require("mason-null-ls").setup({
				ensure_installed = {
					"eslint",
					"mypy",
					"flake8",
					"black",
					"isort",
					"prettier",
				},
				automatic_installation = false,
				handlers = {
					mypy = function()
						null_ls.register(null_ls.builtins.diagnostics.mypy.with({
							prefer_local = ".venv/bin",
						}))
					end,
					flake8 = function()
						null_ls.register(null_ls.builtins.diagnostics.flake8.with({
							prefer_local = ".venv/bin",
						}))
					end,
					black = function()
						null_ls.register(null_ls.builtins.formatting.black.with({
							prefer_local = ".venv/bin",
						}))
					end,
					isort = function()
						null_ls.register(null_ls.builtins.formatting.isort.with({
							prefer_local = ".venv/bin",
						}))
					end,
				},
			})
			null_ls.setup({
				debug = true,
			})

			local format_is_enabled = true
			vim.api.nvim_create_user_command("FormatToggle", function()
				format_is_enabled = not format_is_enabled
				print("Setting autoformatting to: " .. tostring(format_is_enabled))
			end, {})

			local _augroups = {}
			local get_augroup = function(client)
				if not _augroups[client.id] then
					local group_name = "lsp-format-" .. client.name
					local id = vim.api.nvim_create_augroup(group_name, { clear = true })
					_augroups[client.id] = id
				end

				return _augroups[client.id]
			end

			vim.api.nvim_create_autocmd("LspAttach", {
				group = vim.api.nvim_create_augroup("lsp-attach-format", { clear = true }),
				callback = function(args)
					local client_id = args.data.client_id
					local client = vim.lsp.get_client_by_id(client_id)
					local bufnr = args.buf

					if not client.server_capabilities.documentFormattingProvider then
						return
					end

					if client.name ~= "null-ls" then
						return
					end

					vim.api.nvim_create_autocmd("BufWritePre", {
						group = get_augroup(client),
						buffer = bufnr,
						callback = function()
							if not format_is_enabled then
								return
							end

							vim.lsp.buf.format({
								async = false,
								filter = function(c)
									return c.id == client.id
								end,
							})
						end,
					})
				end,
			})
		end,
	},
}
